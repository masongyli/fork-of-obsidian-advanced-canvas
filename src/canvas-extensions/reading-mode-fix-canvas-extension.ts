import { Canvas, CanvasNode } from 'src/@types/Canvas'
import CanvasExtension from './canvas-extension'

/*
 * [LLM agent change] This file was modified by an LLM agent (Claude), see AGENTS.md:
 * - Vertical spaces are no longer inserted where markdown syntax doesn't allow inline HTML
 *   (fenced code blocks, math blocks, tables, frontmatter). There the HTML was shown as literal text
 *   or broke the block (e.g. a code block's closing fence stopped closing it).
 * - The transformation is applied every time the renderer receives text, instead of only once after
 *   the first render. Before, it was lost as soon as a node was edited once.
 * - Text containing the vertical spaces is never saved back to the node / file.
 * - An empty last line (text ending with a line break) gets a vertical space as well, like the editor shows it.
 */

const VERTICAL_SPACE = '<span class="vertical-space">&nbsp;</span>'

type Fence = { char: string, length: number }

export default class ReadingModeFixCanvasExtension extends CanvasExtension {
  private hookedRenderers = new WeakSet<object>()
  private hookedChildren = new WeakSet<object>()

  isEnabled() { return 'readingModeFixEnabled' as const }

  init() {
    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:node-rendered',
      (_canvas: Canvas, node: CanvasNode) => this.updateNodeRenderer(node)
    ))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:node-editing-state-changed',
      (_canvas: Canvas, node: CanvasNode, isEditing: boolean) => {
        if (isEditing) return
        this.updateNodeRenderer(node)
      }
    ))
  }

  private isFeatureEnabled() {
    return this.plugin.settings.getSetting('readingModeFixEnabled')
  }

  private updateNodeRenderer(node: CanvasNode) {
    const child = node.child
    const renderer = child?.previewMode?.renderer
    if (!child || !renderer) return

    // [LLM agent change] Reading view edits (e.g. toggling a checkbox) are made on the renderer's text,
    // which contains the vertical spaces. Strip them before the text gets saved to the node / file.
    const originalSave = child.save
    if (originalSave && !this.hookedChildren.has(child)) {
      this.hookedChildren.add(child)

      child.save = (text: string, ...args: unknown[]) => {
        originalSave.call(
          child,
          typeof text === 'string' ? ReadingModeFixCanvasExtension.removeVerticalSpaces(text) : text,
          ...args
        )
      }
    }

    if (this.hookedRenderers.has(renderer)) return
    this.hookedRenderers.add(renderer)

    // [LLM agent change] Transform every text that is set (initial render, after editing, ...), instead of
    // transforming once in renderer.onRendered().
    const originalSet = renderer.set
    renderer.set = (text: string) => {
      const cleanText = ReadingModeFixCanvasExtension.removeVerticalSpaces(text ?? "")
      originalSet.call(renderer, this.isFeatureEnabled() ? ReadingModeFixCanvasExtension.addVerticalSpaces(cleanText) : cleanText)
    }

    // The text may already have been set before the renderer got hooked
    if (renderer.text) renderer.set(renderer.text)
  }

  static removeVerticalSpaces(text: string): string {
    const cleanText = text.replaceAll(`${VERTICAL_SPACE}\n`, '\n')

    // [LLM agent change] The empty last line (text ending with a line break) gets a vertical space
    // that isn't followed by a line break, see addVerticalSpaces()
    return cleanText.endsWith(`\n${VERTICAL_SPACE}`) ? cleanText.slice(0, -VERTICAL_SPACE.length) : cleanText
  }

  /**
   * [LLM agent change] Appends a vertical space to every line that is followed by a line break,
   * except for lines where markdown syntax doesn't allow inline HTML. The line count is kept,
   * so line numbers (e.g. MarkdownPostProcessorContext.getSectionInfo) still match the source.
   *
   * [LLM agent change] If the text ends with a line break, the editor shows an empty last line,
   * but markdown drops it. It gets a vertical space too, so the reading view has the same height.
   */
  static addVerticalSpaces(text: string): string {
    const lines = text.split('\n')
    const skippedLines = ReadingModeFixCanvasExtension.getLinesWithoutVerticalSpace(lines)
    const lastLine = lines.length - 1
    const hasEmptyLastLine = lastLine > 0 && lines[lastLine] === ''

    return lines.map((line, i) =>
      (i < lastLine || hasEmptyLastLine) && !skippedLines.has(i) ? line + VERTICAL_SPACE : line
    ).join('\n')
  }

  private static getLinesWithoutVerticalSpace(lines: string[]): Set<number> {
    const skipped = new Set<number>()
    // Content of a line without blockquote/callout markers (e.g. "> > ```js" -> "```js")
    const content = (line: string) => line.replace(/^(?:\s{0,3}>\s?)+/, '')

    let start = 0

    // Frontmatter
    if (lines[0]?.trimEnd() === '---') {
      const end = lines.findIndex((line, i) => i > 0 && (line.trimEnd() === '---' || line.trimEnd() === '...'))
      if (end > 0) {
        for (let i = 0; i <= end; i++) skipped.add(i)
        start = end + 1
      }
    }

    let fence: Fence | null = null
    let inMathBlock = false

    for (let i = start; i < lines.length; i++) {
      const line = content(lines[i])

      // Fenced code block (including both fence lines)
      if (fence) {
        skipped.add(i)
        const closingFence = line.match(/^\s*(`{3,}|~{3,})\s*$/)
        if (closingFence && closingFence[1][0] === fence.char && closingFence[1].length >= fence.length) fence = null
        continue
      }

      const openingFence = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
      if (openingFence && !(openingFence[1][0] === '`' && openingFence[2].includes('`'))) {
        skipped.add(i)
        fence = { char: openingFence[1][0], length: openingFence[1].length }
        continue
      }

      // Math block ($$ ... $$)
      const mathDelimiters = (line.match(/\$\$/g) ?? []).length
      if (inMathBlock) {
        skipped.add(i)
        if (mathDelimiters % 2 === 1) inMathBlock = false
        continue
      }

      if (line.trimStart().startsWith('$$')) {
        skipped.add(i)
        if (mathDelimiters % 2 === 1) inMathBlock = true
        continue
      }

      // Table: header row + delimiter row + following non-empty rows
      if (i > 0 && !skipped.has(i - 1) && ReadingModeFixCanvasExtension.isTableDelimiterRow(line) && content(lines[i - 1]).includes('|')) {
        let end = i
        while (end + 1 < lines.length && content(lines[end + 1]).trim() !== '') end++

        for (let row = i - 1; row <= end; row++) skipped.add(row)

        // Keep the empty lines around the table empty, a vertical space line would be merged into the table
        if (i - 2 >= 0 && lines[i - 2].trim() === '') skipped.add(i - 2)
        if (end + 1 < lines.length) skipped.add(end + 1)

        i = end + 1
        continue
      }
    }

    return skipped
  }

  private static isTableDelimiterRow(line: string): boolean {
    return line.includes('|') && line.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)
  }
}
