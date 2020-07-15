// 2x canvas for auto smoothing?
// matrix transform for scale transforms

import * as Regl from "regl"

const WHITE: [number, number, number, number] = [ 1, 1, 1, 1 ]
const devicePixelRatio = window.devicePixelRatio || 1;
const canvas = document.createElement('canvas');
canvas.width = 1200 * devicePixelRatio;
canvas.height = 800 * devicePixelRatio;

canvas.style.width = (canvas.width / devicePixelRatio) + 'px';
canvas.style.height = (canvas.height / devicePixelRatio) + 'px';

document.body.appendChild(canvas);

const regl = Regl({
  canvas: canvas,
  extensions: ['angle_instanced_arrays', 'OES_standard_derivatives'],
  attributes: {antialias: true}},
)

const N = 2000

// Simulate a Bokeh ColumnDataSource
const source = {
  data: {
    x: Float32Array.from(Array(N).fill(0).map((_, i) =>  {return -1 + 2 * Math.random() + 1./N})),
    y: Float32Array.from(Array(N).fill(0).map((_, i) =>  {return -1 + 2 * Math.random() + 1./N})),
    size: Float32Array.from(Array(N).fill(0).map((_, i) => { return Math.random() * 41.05 + 41.02 })),
    angle: Float32Array.from(Array(N).fill(0).map((_, i) => { return Math.random() * 2*Math.PI })),
    fill_color: Array(N).fill(0).map((_, i) => { return [Math.random(), Math.random(), 0.5] }),
    line_color: Array(N).fill(0).map((_, i) => { return [0.8, Math.random(), Math.random()] }),
    line_width: Array(N).fill(0).map((_, i) => { return Math.random()*5 + 1}),
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
  // angle: {field: "angle"},
  fill_color: {field: "fill_color"},
  fill_alpha: {value: 0.3},
  //line_color: {value: [0.0, 0.3, 0.4]},
  line_color: {field: "fill_color"},
  line_alpha: {value: 1.0},
  line_width: {value: 6.0},
  //line_width: {field: "line_width"},
}


function declare_attribute(name: string): string {
  const typ = name.match("color") ? "vec3" : "float"
  return `attribute ${typ} a_${name};`
}

function declare_uniform(name: string): string {
  const typ = name.match("color") ? "vec3" : "float"
  return `uniform ${typ} u_${name};`
}

function declare_varying(name: string): string {
  const typ = name.match("color") ? "vec3" : "float"
  return `varying ${typ} v_${name};`
}

const MARKER_PROPERTIES: string[] = [
  "x", "y", "size", "angle", "fill_color", "fill_alpha", "line_color", "line_alpha", "line_width"
]

function attr_declarations(marker: any): string {
  let result = ""
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].field !== undefined) {
      result += `${declare_attribute(prop)}\n`
    }
  }
  return result
}

function uniform_declarations(marker: any): string {
  let result = ""
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].value !== undefined) {
      result += `${declare_uniform(prop)}\n`
    }
  }
  return result
}

function varying_declarations(marker: any): string {
  let result = ""
  for (let prop of MARKER_PROPERTIES) {
    result += `${declare_varying(prop)}\n`
  }
  return result
}

function varying_assignments(marker: any): string {
  let result = ""
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].field !== undefined) {
      result += `  v_${prop} = a_${prop};\n`
    }
    else {
      result += `  v_${prop} = u_${prop};\n`
    }
  }
  return result
}

function vn(marker: any, prop: string): string {
  if (marker[prop].field !== undefined) {
      return `a_${prop}`
    }
  return `u_${prop}`
}

function make_uniforms(marker: any, source: any): any {
  const result = {
    canvas_width: regl.context('viewportWidth'),
    canvas_height: regl.context('viewportHeight'),
  }
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].value !== undefined)
      result["u_" + prop] = marker[prop].value
  }
  return result
}

function make_attributes(marker: any, source: any, position: number[][]): any {
  const result = {position: position}
  for (let prop of MARKER_PROPERTIES) {
    if (marker[prop].field !== undefined) {
      const data = source.data[marker[prop].field]
      const buffer =  regl.buffer({data: data, usage: "dynamic"})
      result["a_" + prop] = {buffer: buffer, divisor: 1}
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

  abstract distance(): string

  vert_shader(marker: any): string {
    return `
precision mediump float;
attribute vec2 position;

${attr_declarations(marker)}
${uniform_declarations(marker)}
${varying_declarations(marker)}

void main() {
  gl_PointSize = ${vn(marker, "size")};
  gl_Position = vec4(position.x + ${vn(marker, "x")}, position.y + ${vn(marker, "y")}, 0, 1);

${varying_assignments(marker)}
}
`
  }

  frag_shader(marker: any): string {
    return `
precision mediump float;

const float SQRT_2 = 1.4142135623730951;
const float SQRT_3 = 1.7320508075688772;
const float PI = 3.14159265358979323846264;

${uniform_declarations(marker)}
${varying_declarations(marker)}

vec4 outline(float distance, float antialias, vec4 fill_color, vec4 line_color, float line_width) {
  vec4 frag_color;

  float t = line_width/2.0 - antialias;
  float signed_distance = distance;
  float border_distance = abs(signed_distance) - t;
  float alpha = border_distance/antialias;
  alpha = exp(-alpha*alpha);

  // If line alpha is zero, it means no outline. To avoid a dark outline shining
  // through due to AA, we set the line color to the fill color and avoid branching.
  float select = float(bool(line_color.a));
  line_color.rgb = select * line_color.rgb + (1.0  - select) * fill_color.rgb;

  // Similarly, if we want a transparent fill
  select = float(bool(fill_color.a));
  fill_color.rgb = select * fill_color.rgb + (1.0  - select) * line_color.rgb;

  if (border_distance < 0.0)
      frag_color = line_color;
  else if (signed_distance < 0.0) {
      frag_color = mix(fill_color, line_color, sqrt(alpha));
  } else {
      if (abs(signed_distance) < (line_width/2.0 + antialias) ) {
          frag_color = vec4(line_color.rgb, line_color.a * alpha);
      } else {
        frag_color = vec4(line_color.rgb, 0.0);
      }
  }

  return frag_color;
}

${this.distance()}

void main () {
  vec4 fill_color = vec4(v_fill_color, v_fill_alpha);
  vec4 line_color = vec4(v_line_color, v_line_alpha);

  vec2 P = 2.0 * gl_PointCoord - 1.0;
  P = vec2(
      cos(v_angle) * P.x + sin(v_angle) * P.y,
    -sin(v_angle) * P.x + cos(v_angle) * P.y
  );

  float point_size = v_size + 2.0 * (v_line_width + 1.5);
  P *= point_size;
  P.y *= -1.0;

  float dist = distance(P, v_size);

  gl_FragColor = outline(dist, 0.8, fill_color, line_color, v_line_width);
}`
  }

  public generate(): Regl.DrawCommand {
    console.log(this.vert_shader(this.marker))
    console.log(this.frag_shader(this.marker))
    return regl({
      frag: this.frag_shader(this.marker),
      vert: this.vert_shader(this.marker),
      attributes: make_attributes(this.marker, this.source, [[0.0, 0.0]]),
      uniforms: make_uniforms(this.marker, this.source),
      count: 1,
      instances: N,
      primitive: "points",
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

function distance(code: string): string {
  return `
float distance(vec2 P, float size) {
  ${code.trim()}
}
`
}

class CircleProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  return length(P) - size/2.0;
  `)
  }
}

class DotProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float v = length(P) - size/8.0;
  return max(-step(0.0, v), v);
  `)
  }
}

class CircleDotProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float circle = length(P) - size/2.0;
  float v = length(P) - size/8.0;
  float dot = max(-step(0.0, v), v);
  return circle * step(0.0, v);
  `)
  }
}


class SquareProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  return max(abs(P.x), abs(P.y)) - v_size/2.0;
    `)
  }
}

class SquareDotProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float square = max(abs(P.x), abs(P.y)) - v_size/2.0;
  float v = length(P) - size/8.0;
  float dot = max(-step(0.0, v), v);
  return square * step(0.0, v);
    `)
  }
}


class DiamondProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float x = SQRT_2 / 2.0 * (P.x * 1.5 - P.y);
  float y = SQRT_2 / 2.0 * (P.x * 1.5 + P.y);
  float r1 = max(abs(x), abs(y)) - v_size / (2.0 * SQRT_2);
  return r1 / SQRT_2;
  `)
  }
}

class DiamondDotProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float x = SQRT_2 / 2.0 * (P.x * 1.5 - P.y);
  float y = SQRT_2 / 2.0 * (P.x * 1.5 + P.y);
  float r1 = max(abs(x), abs(y)) - v_size / (2.0 * SQRT_2);
  float diamond = r1 / SQRT_2;
  float v = length(P) - size/8.0;
  float dot = max(-step(0.0, v), v);
  return diamond * step(0.0, v);
  `)
  }
}

class TriangleProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  P.y *= -1.0;
  P.y -= size * 0.3;
  float x = SQRT_2 / 2.0 * (P.x * 1.7 - P.y);
  float y = SQRT_2 / 2.0 * (P.x * 1.7 + P.y);
  float r1 = max(abs(x), abs(y)) - v_size / 1.6;
  float r2 = P.y;
  return max(r1 / SQRT_2, r2);  // Intersect diamond with rectangle
  `)
  }
}

class TriangleDotProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  P.y *= -1.0;
  float tPy = P.y - size * 0.3;
  float x = SQRT_2 / 2.0 * (P.x * 1.7 - tPy);
  float y = SQRT_2 / 2.0 * (P.x * 1.7 + tPy);
  float r1 = max(abs(x), abs(y)) - v_size / 1.6;
  float r2 = tPy;
  float triangle = max(r1 / SQRT_2, r2);  // Intersect diamond with rectangle
  float v = length(P) - size/8.0;
  float dot = max(-step(0.0, v), v);
  return triangle * step(0.0, v);
    `)
  }
}

class XProgram extends MarkerProgram {
  distance(): string {
    return distance(`
    float circle = length(P) - v_size / 2.0;
    float X = min(abs(P.x - P.y), abs(P.x + P.y)) - v_size / 100.0;  // bit of "width" for aa
    return max(circle, X);
    `)
  }
}

class YProgram extends MarkerProgram {
  distance(): string {
    return distance(`
    float circle = length(P) - v_size / 2.0;
    float bottom = step(0.0, -P.y) * (abs(P.x) - v_size / 100.0);
    float top = step(0.0, P.y) * (min(abs(P.x - SQRT_3*P.y), abs(P.x + SQRT_3*P.y)) - v_size / 40.0);
    return max(circle, bottom+top);
    `)
  }
}

class CircleYProgram extends MarkerProgram {
  distance(): string {
    return distance(`
    float circle = length(P) - v_size / 2.0;
    float bottom = -step(0.0, -P.y) * (abs(P.x) - v_size / 100.0);
    float top = -step(0.0, P.y) * (min(abs(P.x - SQRT_3*P.y), abs(P.x + SQRT_3*P.y)) - v_size / 40.0);
    return min(max(circle, bottom),  max(circle, top));
    `)
  }
}

class HexProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  vec2 q = abs(P);
  return max(q.y * 0.57735 + q.x - 1.0 * size/2.0, q.y - 0.866 * size/2.0);
  `)
  }
}

class HexDotProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  vec2 q = abs(P);
  float hex = max(q.y * 0.57735 + q.x - 1.0 * size/2.0, q.y - 0.866 * size/2.0);
  float v = length(P) - size/8.0;
  float dot = max(-step(0.0, v), v);
  return hex * step(0.0, v);
  `)
  }
}

class PlusProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float square = max(abs(P.x), abs(P.y)) - size / 2.0;   // 2.5 is a tweak?
  float cross = min(abs(P.x), abs(P.y)) - 3.0 * size / 16.0;
  return max(square, cross);
  `)
  }
}

class CrossProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float square = max(abs(P.x), abs(P.y)) - size / 2.0;   // 2.5 is a tweak?
  float cross = min(abs(P.x), abs(P.y)) - size / 100.0;  // bit of "width" for aa
  return max(square, cross);
  `)
  }
}

class DashProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float square = max(abs(P.x), abs(P.y)) - size / 2.0;   // 2.5 is a tweak?
  float cross = abs(P.y) - size / 100.0;  // bit of "width" for aa
  return max(square, cross);
  `)
  }
}

class CircleCrossProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  // Define quadrants
  float qs = size / 2.0;  // quadrant size
  float s1 = max(abs(P.x - qs), abs(P.y - qs)) - qs;
  float s2 = max(abs(P.x + qs), abs(P.y - qs)) - qs;
  float s3 = max(abs(P.x - qs), abs(P.y + qs)) - qs;
  float s4 = max(abs(P.x + qs), abs(P.y + qs)) - qs;
  // Intersect main shape with quadrants (to form cross)
  float circle = length(P) - size/2.0;
  float c1 = max(circle, s1);
  float c2 = max(circle, s2);
  float c3 = max(circle, s3);
  float c4 = max(circle, s4);
  // Union
  return min(min(min(c1, c2), c3), c4);
  `)
  }
}

class SquareCrossProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  // Define quadrants
  float qs = size / 2.0;  // quadrant size
  float s1 = max(abs(P.x - qs), abs(P.y - qs)) - qs;
  float s2 = max(abs(P.x + qs), abs(P.y - qs)) - qs;
  float s3 = max(abs(P.x - qs), abs(P.y + qs)) - qs;
  float s4 = max(abs(P.x + qs), abs(P.y + qs)) - qs;
  // Intersect main shape with quadrants (to form cross)
  float square = max(abs(P.x), abs(P.y)) - size/2.0;
  float c1 = max(square, s1);
  float c2 = max(square, s2);
  float c3 = max(square, s3);
  float c4 = max(square, s4);
  // Union
  return min(min(min(c1, c2), c3), c4);
  `)
  }
}

class DiamondCrossProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  // Define quadrants
  float qs = size / 2.0;  // quadrant size
  float s1 = max(abs(P.x - qs), abs(P.y - qs)) - qs;
  float s2 = max(abs(P.x + qs), abs(P.y - qs)) - qs;
  float s3 = max(abs(P.x - qs), abs(P.y + qs)) - qs;
  float s4 = max(abs(P.x + qs), abs(P.y + qs)) - qs;
  // Intersect main shape with quadrants (to form cross)
  float x = SQRT_2 / 2.0 * (P.x * 1.5 - P.y);
  float y = SQRT_2 / 2.0 * (P.x * 1.5 + P.y);
  float diamond = max(abs(x), abs(y)) - size / (2.0 * SQRT_2);
  diamond /= SQRT_2;
  float c1 = max(diamond, s1);
  float c2 = max(diamond, s2);
  float c3 = max(diamond, s3);
  float c4 = max(diamond, s4);
  // Union
  return min(min(min(c1, c2), c3), c4);
  `)
  }
}

class CircleXProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float x = P.x - P.y;
  float y = P.x + P.y;
  // Define quadrants
  float qs = size / 2.0;  // quadrant size
  float s1 = max(abs(x - qs), abs(y - qs)) - qs;
  float s2 = max(abs(x + qs), abs(y - qs)) - qs;
  float s3 = max(abs(x - qs), abs(y + qs)) - qs;
  float s4 = max(abs(x + qs), abs(y + qs)) - qs;
  // Intersect main shape with quadrants (to form cross)
  float circle = length(P) - size/2.0;
  float c1 = max(circle, s1);
  float c2 = max(circle, s2);
  float c3 = max(circle, s3);
  float c4 = max(circle, s4);
  // Union
  return min(min(min(c1, c2), c3), c4);
  `)
  }
}

class SquareXProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  float x = P.x - P.y;
  float y = P.x + P.y;
  // Define quadrants
  float qs = size / 2.0;  // quadrant size
  float s1 = max(abs(x - qs), abs(y - qs)) - qs;
  float s2 = max(abs(x + qs), abs(y - qs)) - qs;
  float s3 = max(abs(x - qs), abs(y + qs)) - qs;
  float s4 = max(abs(x + qs), abs(y + qs)) - qs;
  // Intersect main shape with quadrants (to form cross)
  float square = max(abs(P.x), abs(P.y)) - size/2.0;
  float c1 = max(square, s1);
  float c2 = max(square, s2);
  float c3 = max(square, s3);
  float c4 = max(square, s4);
  // Union
  return min(min(min(c1, c2), c3), c4);
  `)
  }
}

class AsteriskProgram extends MarkerProgram {
  distance(): string {
    return distance(`
  // Masks
  float diamond = max(abs(SQRT_2 / 2.0 * (P.x - P.y)), abs(SQRT_2 / 2.0 * (P.x + P.y))) - size / (2.0 * SQRT_2);
  float square = max(abs(P.x), abs(P.y)) - size / (2.0 * SQRT_2);
  // Shapes
  float X = min(abs(P.x - P.y), abs(P.x + P.y)) - size / 100.0;  // bit of "width" for aa
  float cross = min(abs(P.x), abs(P.y)) - size / 100.0;  // bit of "width" for aa
  // Result is union of masked shapes
  return min(max(X, diamond), max(cross, square));
  `)
  }
}

const program = new TriangleDotProgram(glyph, source)

const command = program.generate()

function update() {
  regl.clear({ color: WHITE })
  command(canvas)
}

update()
//regl.frame(update)