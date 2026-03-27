import type { Point, Polygon, Part } from '$lib/geometry/types';
import {
	type AffineMatrix, IDENTITY,
	multiplyMatrices, applyMatrixToPolygon,
	cubicBezier, quadraticBezier, parseTransformAttr
} from '$lib/geometry/affine';
import { CURVE_SEGMENTS, CIRCLE_SEGMENTS, MAX_DEPTH, MAX_FILE_SIZE } from './constants';

function arcToPoints(
	cx: number, cy: number, rx: number, ry: number,
	startAngle: number, endAngle: number, segments: number
): Point[] {
	const points: Point[] = [];
	const delta = endAngle - startAngle;
	for (let i = 0; i <= segments; i++) {
		const angle = startAngle + (delta * i) / segments;
		points.push({
			x: cx + rx * Math.cos(angle),
			y: cy + ry * Math.sin(angle)
		});
	}
	return points;
}

interface PathToken {
	command: string;
	args: number[];
}

function tokenizePath(d: string): PathToken[] {
	const tokens: PathToken[] = [];
	const regex = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
	let currentCommand = '';
	let currentArgs: number[] = [];
	let match;

	while ((match = regex.exec(d)) !== null) {
		if (match[1]) {
			if (currentCommand) {
				tokens.push({ command: currentCommand, args: currentArgs });
			}
			currentCommand = match[1];
			currentArgs = [];
		} else if (match[2]) {
			currentArgs.push(parseFloat(match[2]));
		}
	}
	if (currentCommand) {
		tokens.push({ command: currentCommand, args: currentArgs });
	}

	// Split commands with multiple coordinate sets
	const expanded: PathToken[] = [];
	for (const token of tokens) {
		const argCounts: Record<string, number> = {
			M: 2, m: 2, L: 2, l: 2, H: 1, h: 1, V: 1, v: 1,
			C: 6, c: 6, S: 4, s: 4, Q: 4, q: 4, T: 2, t: 2,
			A: 7, a: 7, Z: 0, z: 0
		};
		const count = argCounts[token.command] ?? 0;
		if (count === 0 || token.args.length <= count) {
			expanded.push(token);
		} else {
			for (let i = 0; i < token.args.length; i += count) {
				const cmd = i === 0 ? token.command :
					(token.command === 'M' ? 'L' : token.command === 'm' ? 'l' : token.command);
				expanded.push({ command: cmd, args: token.args.slice(i, i + count) });
			}
		}
	}

	return expanded;
}

function parsePath(d: string): Polygon[] {
	const tokens = tokenizePath(d);
	const polygons: Polygon[] = [];
	let currentPoly: Point[] = [];
	let cx = 0, cy = 0;
	let sx = 0, sy = 0;
	let lastCp: Point | null = null;

	for (const { command, args } of tokens) {
		switch (command) {
			case 'M':
				if (currentPoly.length > 0) { polygons.push(currentPoly); currentPoly = []; }
				cx = args[0]; cy = args[1]; sx = cx; sy = cy;
				currentPoly.push({ x: cx, y: cy }); lastCp = null; break;
			case 'm':
				if (currentPoly.length > 0) { polygons.push(currentPoly); currentPoly = []; }
				cx += args[0]; cy += args[1]; sx = cx; sy = cy;
				currentPoly.push({ x: cx, y: cy }); lastCp = null; break;
			case 'L': cx = args[0]; cy = args[1]; currentPoly.push({ x: cx, y: cy }); lastCp = null; break;
			case 'l': cx += args[0]; cy += args[1]; currentPoly.push({ x: cx, y: cy }); lastCp = null; break;
			case 'H': cx = args[0]; currentPoly.push({ x: cx, y: cy }); lastCp = null; break;
			case 'h': cx += args[0]; currentPoly.push({ x: cx, y: cy }); lastCp = null; break;
			case 'V': cy = args[0]; currentPoly.push({ x: cx, y: cy }); lastCp = null; break;
			case 'v': cy += args[0]; currentPoly.push({ x: cx, y: cy }); lastCp = null; break;
			case 'C': {
				const pts = cubicBezier({ x: cx, y: cy }, { x: args[0], y: args[1] }, { x: args[2], y: args[3] }, { x: args[4], y: args[5] }, CURVE_SEGMENTS);
				currentPoly.push(...pts); lastCp = { x: args[2], y: args[3] }; cx = args[4]; cy = args[5]; break;
			}
			case 'c': {
				const pts = cubicBezier({ x: cx, y: cy }, { x: cx + args[0], y: cy + args[1] }, { x: cx + args[2], y: cy + args[3] }, { x: cx + args[4], y: cy + args[5] }, CURVE_SEGMENTS);
				lastCp = { x: cx + args[2], y: cy + args[3] }; currentPoly.push(...pts); cx += args[4]; cy += args[5]; break;
			}
			case 'S': {
				const cp1 = lastCp ? { x: 2 * cx - lastCp.x, y: 2 * cy - lastCp.y } : { x: cx, y: cy };
				const pts = cubicBezier({ x: cx, y: cy }, cp1, { x: args[0], y: args[1] }, { x: args[2], y: args[3] }, CURVE_SEGMENTS);
				lastCp = { x: args[0], y: args[1] }; currentPoly.push(...pts); cx = args[2]; cy = args[3]; break;
			}
			case 's': {
				const cp1 = lastCp ? { x: 2 * cx - lastCp.x, y: 2 * cy - lastCp.y } : { x: cx, y: cy };
				const pts = cubicBezier({ x: cx, y: cy }, cp1, { x: cx + args[0], y: cy + args[1] }, { x: cx + args[2], y: cy + args[3] }, CURVE_SEGMENTS);
				lastCp = { x: cx + args[0], y: cy + args[1] }; currentPoly.push(...pts); cx += args[2]; cy += args[3]; break;
			}
			case 'Q': {
				const pts = quadraticBezier({ x: cx, y: cy }, { x: args[0], y: args[1] }, { x: args[2], y: args[3] }, CURVE_SEGMENTS);
				lastCp = { x: args[0], y: args[1] }; currentPoly.push(...pts); cx = args[2]; cy = args[3]; break;
			}
			case 'q': {
				const pts = quadraticBezier({ x: cx, y: cy }, { x: cx + args[0], y: cy + args[1] }, { x: cx + args[2], y: cy + args[3] }, CURVE_SEGMENTS);
				lastCp = { x: cx + args[0], y: cy + args[1] }; currentPoly.push(...pts); cx += args[2]; cy += args[3]; break;
			}
			case 'T': {
				const cp = lastCp ? { x: 2 * cx - lastCp.x, y: 2 * cy - lastCp.y } : { x: cx, y: cy };
				const pts = quadraticBezier({ x: cx, y: cy }, cp, { x: args[0], y: args[1] }, CURVE_SEGMENTS);
				lastCp = cp; currentPoly.push(...pts); cx = args[0]; cy = args[1]; break;
			}
			case 't': {
				const cp = lastCp ? { x: 2 * cx - lastCp.x, y: 2 * cy - lastCp.y } : { x: cx, y: cy };
				const pts = quadraticBezier({ x: cx, y: cy }, cp, { x: cx + args[0], y: cy + args[1] }, CURVE_SEGMENTS);
				lastCp = cp; currentPoly.push(...pts); cx += args[0]; cy += args[1]; break;
			}
			case 'Z': case 'z':
				if (currentPoly.length > 1) {
					const last = currentPoly[currentPoly.length - 1];
					const first = currentPoly[0];
					if (Math.abs(last.x - first.x) < 0.001 && Math.abs(last.y - first.y) < 0.001) {
						currentPoly.pop();
					}
				}
				cx = sx; cy = sy; lastCp = null; break;
		}
	}

	if (currentPoly.length > 0) polygons.push(currentPoly);
	return polygons;
}

function parsePointsAttr(attr: string): Polygon {
	const nums = attr.trim().split(/[\s,]+/).map(Number);
	const points: Point[] = [];
	for (let i = 0; i < nums.length; i += 2) {
		points.push({ x: nums[i], y: nums[i + 1] });
	}
	return points;
}

function processElement(
	el: Element,
	parentMatrix: AffineMatrix,
	parts: Part[],
	counter: { value: number },
	depth: number
): void {
	if (depth > MAX_DEPTH) return;

	const localTransform = parseTransformAttr(el.getAttribute('transform'));
	const matrix = multiplyMatrices(parentMatrix, localTransform);
	const tag = el.tagName.toLowerCase();

	if (tag === 'g') {
		for (const child of Array.from(el.children)) {
			processElement(child, matrix, parts, counter, depth + 1);
		}
		return;
	}

	let polygons: Polygon[] = [];

	switch (tag) {
		case 'rect': {
			const x = parseFloat(el.getAttribute('x') ?? '0');
			const y = parseFloat(el.getAttribute('y') ?? '0');
			const w = parseFloat(el.getAttribute('width') ?? '0');
			const h = parseFloat(el.getAttribute('height') ?? '0');
			polygons = [[ { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h } ]];
			break;
		}
		case 'circle': {
			const ccx = parseFloat(el.getAttribute('cx') ?? '0');
			const ccy = parseFloat(el.getAttribute('cy') ?? '0');
			const r = parseFloat(el.getAttribute('r') ?? '0');
			polygons = [arcToPoints(ccx, ccy, r, r, 0, 2 * Math.PI, CIRCLE_SEGMENTS).slice(0, -1)];
			break;
		}
		case 'ellipse': {
			const ccx = parseFloat(el.getAttribute('cx') ?? '0');
			const ccy = parseFloat(el.getAttribute('cy') ?? '0');
			const rx = parseFloat(el.getAttribute('rx') ?? '0');
			const ry = parseFloat(el.getAttribute('ry') ?? '0');
			polygons = [arcToPoints(ccx, ccy, rx, ry, 0, 2 * Math.PI, CIRCLE_SEGMENTS).slice(0, -1)];
			break;
		}
		case 'polygon': case 'polyline': {
			const pts = el.getAttribute('points');
			if (pts) polygons = [parsePointsAttr(pts)];
			break;
		}
		case 'path': {
			const d = el.getAttribute('d');
			if (d) polygons = parsePath(d);
			break;
		}
	}

	if (polygons.length > 0) {
		const transformed = polygons.map((p) => applyMatrixToPolygon(matrix, p));
		const id = el.getAttribute('id') || `${tag}-${counter.value}`;
		parts.push({ id: `part-${counter.value}`, name: id, polygons: transformed, sourceIndex: counter.value });
		counter.value++;
	}
}

export function parseSVG(svgString: string): Part[] {
	if (svgString.length > MAX_FILE_SIZE) {
		throw new Error(`SVG file too large (${(svgString.length / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
	}

	// No regex sanitization needed — processElement only walks known shape elements
	// (rect, circle, ellipse, polygon, polyline, path, g) and extracts numeric attributes.
	// Script, foreignObject, event handlers, etc. are structurally ignored.
	const parser = new DOMParser();
	const doc = parser.parseFromString(svgString, 'image/svg+xml');
	const svg = doc.documentElement;
	const parts: Part[] = [];
	const counter = { value: 0 };

	for (const child of Array.from(svg.children)) {
		processElement(child as Element, IDENTITY, parts, counter, 0);
	}

	return parts;
}
