/* eslint-disable-next-line import/no-extraneous-dependencies -- Included in Obsidian */
import { ViewUpdate } from "@codemirror/view"
import { Canvas, CanvasNode } from "src/@types/Canvas"
import CanvasHelper from "src/utils/canvas-helper"
import CanvasExtension from "./canvas-extension"
import { CanvasFileNodeData, CanvasNodeData } from "src/@types/AdvancedJsonCanvas"

export default class AutoResizeNodeCanvasExtension  extends CanvasExtension {
  isEnabled() { return 'autoResizeNodeFeatureEnabled' as const }

  init() {
    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:node-created',
      (canvas: Canvas, node: CanvasNode) => this.onNodeCreated(canvas, node)
    ))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:popup-menu-created',
      (canvas: Canvas) => this.onPopupMenuCreated(canvas)
    ))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:node-editing-state-changed',
      (canvas: Canvas, node: CanvasNode, editing: boolean) => void this.onNodeEditingStateChanged(canvas, node, editing)
    ))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:node-text-content-changed',
      (canvas: Canvas, node: CanvasNode, viewUpdate: ViewUpdate) => void this.onNodeTextContentChanged(canvas, node, viewUpdate.view.dom)
    ))
  }

  private isValidNodeType(nodeData: CanvasNodeData) {
    return nodeData.type === 'text' || (nodeData.type === 'file' && (nodeData as CanvasFileNodeData).file.endsWith('.md'))
  }

  private onNodeCreated(_canvas: Canvas, node: CanvasNode) {
    const autoResizeNodeEnabledByDefault = this.plugin.settings.getSetting('autoResizeNodeEnabledByDefault')
    if (!autoResizeNodeEnabledByDefault) return

    const nodeData = node.getData()
    if (nodeData.type !== 'text' && nodeData.type !== 'file') return // File extension can still be changed in the future

    node.setData({
      ...node.getData(),
      dynamicHeight: true
    })
  }

  private onPopupMenuCreated(canvas: Canvas) {
    if (canvas.readonly) return

    const selectedNodes = canvas.getSelectionData().nodes
      .filter(nodeData => this.isValidNodeType(nodeData))
      .map(nodeData => canvas.nodes.get(nodeData.id))
      .filter(node => node !== undefined)
    if (selectedNodes.length === 0) return

    const autoResizeHeightEnabled = selectedNodes.some(node => node.getData().dynamicHeight)

    CanvasHelper.addPopupMenuOption(
      canvas,
      CanvasHelper.createPopupMenuOption({
        id: 'auto-resize-height',
        label: autoResizeHeightEnabled ? 'Disable auto-resize' : 'Enable auto-resize',
        icon: autoResizeHeightEnabled ? 'scan-text' : 'lock',
        callback: () => this.toggleAutoResizeHeightEnabled(canvas, selectedNodes, autoResizeHeightEnabled)
      })
    )
  }

  private toggleAutoResizeHeightEnabled(canvas: Canvas, nodes: CanvasNode[], autoResizeHeight: boolean) {
    nodes.forEach(node => node.setData({
      ...node.getData(),
      dynamicHeight: !autoResizeHeight
    }))

    this.onPopupMenuCreated(canvas)
  }

  private canBeResized(node: CanvasNode) {
    const nodeData = node.getData()
    return nodeData.dynamicHeight
  }

  private async onNodeEditingStateChanged(_canvas: Canvas, node: CanvasNode, editing: boolean) {
    if (!this.isValidNodeType(node.getData())) return
    if (!this.canBeResized(node)) return

    this.stopObservingRenderedContent(node)

    await sleep(10)

    if (editing) {
      void this.onNodeTextContentChanged(_canvas, node, node.child.editMode.cm.dom)
      return
    }

    this.observeRenderedContent(node)
  }

  /*
   * [LLM agent change] Measuring the reading view once, 10ms after editing ended, often measured the old content:
   * - setIsEditing(false) is called at the start of blur(), the new text is passed to the preview renderer afterwards
   * - renderer.set() only queues the render, it runs later (next animation frame)
   * - Post processors can change the content afterwards as well (e.g. Codeblock Customizer adds its header async)
   * The node kept the height of the old content until the next setIsEditing(false) call (e.g. clicking the node again).
   * Now the size of the rendered content is observed for a short time after editing ended. Only for a short time,
   * so later layout changes (e.g. zoomed out / unloaded node content) don't change the node height.
   */
  private static readonly RENDERED_CONTENT_OBSERVE_DURATION = 1000 // ms
  private renderedContentObservers = new WeakMap<CanvasNode, () => void>()

  private observeRenderedContent(node: CanvasNode) {
    const container = node.nodeEl.querySelector<HTMLElement>(".markdown-preview-view.markdown-rendered")
    if (!container) return

    const content = container.querySelector<HTMLElement>(".markdown-preview-sizer") ?? container
    const observer = new ResizeObserver(() => this.resizeToRenderedContent(node, container))

    const timeout = window.setTimeout(() => this.stopObservingRenderedContent(node), AutoResizeNodeCanvasExtension.RENDERED_CONTENT_OBSERVE_DURATION)
    this.renderedContentObservers.set(node, () => {
      observer.disconnect()
      window.clearTimeout(timeout)
    })

    // Fires once initially as well
    observer.observe(content)
  }

  private stopObservingRenderedContent(node: CanvasNode) {
    this.renderedContentObservers.get(node)?.()
    this.renderedContentObservers.delete(node)
  }

  private resizeToRenderedContent(node: CanvasNode, container: HTMLElement) {
    if (node.isEditing || !this.renderedContentObservers.has(node)) return

    // Don't measure the old content while a render is pending
    if (node.child.previewMode?.renderer?.queued) {
      window.requestAnimationFrame(() => this.resizeToRenderedContent(node, container))
      return
    }

    // [LLM agent change] The sizer is a flex item with "flex: 1 0 0px" and the renderer sets its min-height to the
    // sum of the section heights - 1px. With a min-content container, the sizer got exactly that min-height,
    // so the measured height was 1px less than the content (and than the editor's height -> the node height
    // changed by 1px when switching between reading and editing view). With flex-basis auto, the sizer is at
    // least as tall as its content, the min-height still covers sections that aren't in the DOM (virtual display).
    const sizer = container.querySelector<HTMLElement>(".markdown-preview-sizer")

    container.setCssStyles({ height: "min-content" })
    sizer?.setCssStyles({ flexBasis: "auto" })
    const newHeight = container.clientHeight
    sizer?.setCssStyles({ flexBasis: "" })
    container.setCssStyles({ height: "" })

    this.setNodeHeight(node, newHeight)
  }

  private async onNodeTextContentChanged(_canvas: Canvas, node: CanvasNode, dom: HTMLElement) {
    if (!this.isValidNodeType(node.getData())) return
    if (!this.canBeResized(node)) return

    const cmScroller = dom.querySelector(".cm-scroller") as HTMLElement
    if (!cmScroller) return

    cmScroller.setCssStyles({ height: "min-content" })
    const newHeight = cmScroller.scrollHeight
    cmScroller.setCssStyles({ height: "" })

    this.setNodeHeight(node, newHeight)
  }

  private setNodeHeight(node: CanvasNode, height: number) {
    if (height === 0) return

    // Limit the height to the maximum allowed
    const maxHeight = this.plugin.settings.getSetting('autoResizeNodeMaxHeight')
    if (maxHeight != -1 && height > maxHeight) height = maxHeight

    const nodeData = node.getData()

    height = Math.max(height + 4, node.canvas.config.minContainerDimension)

    if (this.plugin.settings.getSetting('autoResizeNodeSnapToGrid'))
      height = Math.ceil(height / CanvasHelper.GRID_SIZE) * CanvasHelper.GRID_SIZE

    if (height === nodeData.height) return
    node.setData({
      ...nodeData,
      height: height
    })
  }
}
