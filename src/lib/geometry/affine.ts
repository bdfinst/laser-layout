import type { Point, Polygon } from './types';

export interface AffineMatrix {
	a: number; b: number; c: number;
	d: number; e: number; f: number;
}

export const IDENTITY: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiplyMatrices(m1: AffineMatrix, m2: AffineMatrix): AffineMatrix {
	return {
		a: m1.a * m2.a + m1.c * m2.b,
		b: m1.b * m2.a + m1.d * m2.b,
		c: m1.a * m2.c + m1.c * m2.d,
		d: m1.b * m2.c + m1.d * m2.d,
		e: m1.a * m2.e + m1.c * m2.f + m1.e,
		f: m1.b * m2.e + m1.d * m2.f + m1.f
	};
}

export function applyMatrix(m: AffineMatrix, p: Point): Point {
	return {
		x: m.a * p.x + m.c * p.y + m.e,
		y: m.b * p.x + m.d * p.y + m.f
	};
}

export function applyMatrixToPolygon(matrix: AffineMatrix, polygon: Polygon): Polygon {
	return polygon.map((p) => applyMatrix(matrix, p));
}

export function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, segments: number): Point[] {
	const points: Point[] = [];
	for (let i = 1; i <= segments; i++) {
		const t = i / segments;
		const t2 = t * t;
		const t3 = t2 * t;
		const mt = 1 - t;
		const mt2 = mt * mt;
		const mt3 = mt2 * mt;
		points.push({
			x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
			y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y
		});
	}
	return points;
}

export function quadraticBezier(p0: Point, p1: Point, p2: Point, segments: number): Point[] {
	const points: Point[] = [];
	for (let i = 1; i <= segments; i++) {
		const t = i / segments;
		const mt = 1 - t;
		points.push({
			x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
			y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
		});
	}
	return points;
}

export function parseTransformAttr(attr: string | null): AffineMatrix {
	if (!attr) return IDENTITY;

	let result = IDENTITY;
	const regex = /(\w+)\s*\(([^)]+)\)/g;
	let match;

	while ((match = regex.exec(attr)) !== null) {
		const [, fn, args] = match;
		const nums = args.split(/[\s,]+/).map(Number);
		let m = IDENTITY;

		switch (fn) {
			case 'translate':
				m = { a: 1, b: 0, c: 0, d: 1, e: nums[0], f: nums[1] ?? 0 };
				break;
			case 'scale': {
				const sx = nums[0];
				const sy = nums[1] ?? sx;
				m = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
				break;
			}
			case 'rotate': {
				const rad = (nums[0] * Math.PI) / 180;
				const cos = Math.cos(rad);
				const sin = Math.sin(rad);
				if (nums.length === 3) {
					const cx = nums[1], cy = nums[2];
					m = multiplyMatrices(
						{ a: 1, b: 0, c: 0, d: 1, e: cx, f: cy },
						multiplyMatrices(
							{ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 },
							{ a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy }
						)
					);
				} else {
					m = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
				}
				break;
			}
			case 'matrix':
				m = { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] };
				break;
		}
		result = multiplyMatrices(result, m);
	}

	return result;
}
