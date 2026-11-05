export interface Coordinate { x: number; y: number }
export interface CanvasView extends Coordinate { zoom: number }

export const overview: CanvasView = { x: 0.5, y: 0.5, zoom: 1 }
export const maxZoom = 16

export function zoomView(view: CanvasView, zoom: number): CanvasView {
  return zoom === 1 ? overview : { ...view, zoom }
}
