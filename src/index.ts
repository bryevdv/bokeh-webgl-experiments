import * as Regl from "regl"

const WHITE: [number, number, number, number] = [ 1, 1, 1, 1 ]

const canvas = document.createElement('canvas');
canvas.width = 1200
canvas.height = 800
document.body.appendChild(canvas);

const regl = Regl({
  canvas: canvas,
  extensions: ['angle_instanced_arrays', 'OES_standard_derivatives'],
  attributes: {antialias: true}},
)

const N = 1000

// Simulate a Bokeh ColumnDataSource
const source = {
  data: {
    x: Float32Array.from(Array(N).fill(0).map((_, i) =>  {return -1 + 2 * Math.random() + 1./N})),
    y: Float32Array.from(Array(N).fill(0).map((_, i) =>  {return -1 + 2 * Math.random() + 1./N})),
    size: Float32Array.from(Array(N).fill(0).map((_, i) => { return Math.random() * 55 + 20 })),
    fill_color: Array(N).fill(0).map((_, i) => { return [Math.random(), Math.random(), 0.5] }),
  }
}

// Simulate a Bokeh Glyph with scalar/vector attributes
const glyph = {
  x: {field: "x"},
  y: {field: "y"},
  // y: {value: 0},
  size: {field: "size"},
  // size: {value: 30},
  angle: {value: 0},
  fill_color: {field: "fill_color"},
  fill_alpha: {value: 0.3},
}

function declare_attribute(name: string): string {
  const typ = name.match("color") ? "vec3" : "float"
  return `attribute ${typ} ${name};`
}

function declare_uniform(name: string): string {
  const typ = name.match("color") ? "vec3" : "float"
  return `uniform ${typ} ${name};`
}

function declare(name: string, marker: any): string {
  if (marker[name].value !== undefined)
    return declare_uniform(name)
  else
    return declare_attribute(name)
}

function declarations(marker: any): string {
  return `
  ${declare("x", marker)}
  ${declare("y", marker)}
  ${declare("size", marker)}
  ${declare("angle", marker)}
  ${declare("fill_color", marker)}
  ${declare("fill_alpha", marker)}
  `
}

const MARKER_PROPERTIES: string[] = [
  "x", "y", "size", "angle", "fill_color", "fill_alpha"
]

function make_uniforms(marker: any, source: any): any {
  const result = {
    canvas_width: regl.context('viewportWidth'),
    canvas_height: regl.context('viewportHeight'),
  }
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].value !== undefined)
      result[prop] = marker[prop].value
  }
  return result
}

function make_attributes(marker: any, source: any, position: number[][]): any {
  const result = {position: position}
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].field !== undefined) {
      const data = source.data[marker[prop].field]
      const buffer =  regl.buffer({data: data, usage: "dynamic"})
      result[prop] = {buffer: buffer, divisor: 1}
    }
  }
  return result
}

abstract class MarkerProgram {
  static primitive: string = "points"
  static count: number

  marker: any
  source: any

  constructor(marker: any, source: any) {
    this.marker = marker
    this.source = source
  }

  abstract main(): string

  abstract get count(): number
  abstract get position(): number[][]
  abstract get primitive(): string

  vert_shader(marker: any): string {
    return `
    precision mediump float;
    attribute vec2 position;

    ${declarations(marker)}

    varying vec3 v_fill_color;
    varying float v_fill_alpha;

    void main() {
      gl_PointSize = size;
      gl_Position = vec4(position.x + x, position.y + y, 0, 1);
      v_fill_color = fill_color;
      v_fill_alpha = fill_alpha;
    }
    `
  }

  frag_shader(marker: any): string {
    return `
    precision mediump float;

    float smoothStep(float x, float y) {
      return 1.0 / (1.0 + exp(50.0*(x - y)));
    }

    varying vec3 v_fill_color;
    varying float v_fill_alpha;
    ${this.main()}
    `
  }

  public generate(): Regl.DrawCommand {
    return regl({
      frag: this.frag_shader(this.marker),
      vert: this.vert_shader(this.marker),
      attributes: make_attributes(this.marker, this.source, this.position),
      uniforms: make_uniforms(this.marker, this.source),
      count: this.count,
      instances: N,
      primitive: this.primitive as any,  // type?
      depth: { enable: false },
      blend: {
        enable: true,
        func: { srcRGB: 'src alpha', srcAlpha: 1, dstRGB: 'one minus src alpha', dstAlpha: 1 },
        equation: { rgb: 'add', alpha: 'add' },
        color: [0, 0, 0, 0]
      },
    })
  }

}

class CircleProgram extends MarkerProgram {
  main(): string {
    return `
    void main () {
      #extension GL_OES_standard_derivatives : enable
      float r = 0.0, delta = 0.0, alpha = 1.0;
      vec2 cxy = 2.0 * gl_PointCoord - 1.0;
      r = dot(cxy, cxy);
      delta = fwidth(r);
      alpha = 1.0 - smoothstep(1.0 - delta, 1.0 + delta, r);
      gl_FragColor = vec4(v_fill_color, alpha*v_fill_alpha);
    }
    `
  }

  get position(): number[][] {
    return [[0.0, 0.0]]
  }

  get primitive(): string {
    return "points"
  }

  get count(): number {
    return 1
  }

}

const program = new CircleProgram(glyph, source)

const command = program.generate()

function update(context) {
  regl.clear({ color: WHITE })
  command(canvas)
}

regl.frame(update)