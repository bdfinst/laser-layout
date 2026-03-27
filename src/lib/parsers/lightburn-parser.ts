import type { Point, Polygon, Part } from '$lib/geometry/types';
import {
	type AffineMatrix, IDENTITY,
	multiplyMatrices, applyMatrixToPolygon, cubicBezier
} from '$lib/geometry/affine';
import { CURVE_SEGMENTS, CIRCLE_SEGMENTS, MAX_DEPTH, MAX_FILE_SIZE } from './constants';

function parseXForm(el: Element): AffineMatrix {
	const xformEl = el.querySelector(':scope > XForm');
	if (!xformEl?.textContent) return IDENTITY;
	const nums = xformEl.textContent.trim().split(/\s+/).map(Number);
	if (nums.length < 6) return IDENTITY;
	return { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] };
}

interface Vertex {
	x: number; y: number;
	c0x?: number; c0y?: number;
	c1x?: number; c1y?: number;
}

function parseVertList(text: string): Vertex[] {
	const verts: Vertex[] = [];
	const vertRegex = /V([-\d.eE+]+)\s+([-\d.eE+]+)(?:c0x([-\d.eE+]+)c0y([-\d.eE+]+)c1x([-\d.eE+]+)c1y([-\d.eE+]+))?/g;
	let match;
	while ((match = vertRegex.exec(text)) !== null) {
		const v: Vertex = { x: parseFloat(match[1]), y: parseFloat(match[2]) };
		if (match[3] !== undefined) {
			v.c0x = parseFloat(match[3]); v.c0y = parseFloat(match[4]);
			v.c1x = parseFloat(match[5]); v.c1y = parseFloat(match[6]);
		}
		verts.push(v);
	}
	return verts;
}

interface Primitive {
	type: 'B' | 'L';
	from: number;
	to: number;
}

function parsePrimList(text: string): Primitive[] {
	const prims: Primitive[] = [];
	const primRegex = /([BL])(\d+)\s+(\d+)/g;
	let match;
	while ((match = primRegex.exec(text)) !== null) {
		prims.push({ type: match[1] as 'B' | 'L', from: parseInt(match[2]), to: parseInt(match[3]) });
	}
	return prims;
}

function buildPolygonFromPrimitives(verts: Vertex[], prims: Primitive[]): Polygon {
	if (prims.length === 0 || verts.length === 0) return [];

	const points: Point[] = [];
	const firstVert = verts[prims[0].from];
	points.push({ x: firstVert.x, y: firstVert.y });

	for (const prim of prims) {
		const fromVert = verts[prim.from];
		const toVert = verts[prim.to];

		if (prim.type === 'L') {
			points.push({ x: toVert.x, y: toVert.y });
		} else {
			const p0: Point = { x: fromVert.x, y: fromVert.y };
			const p1: Point = { x: fromVert.c0x ?? fromVert.x, y: fromVert.c0y ?? fromVert.y };
			const p2: Point = { x: toVert.c1x ?? toVert.x, y: toVert.c1y ?? toVert.y };
			const p3: Point = { x: toVert.x, y: toVert.y };
			points.push(...cubicBezier(p0, p1, p2, p3, CURVE_SEGMENTS));
		}
	}

	if (points.length > 1) {
		const last = points[points.length - 1];
		const first = points[0];
		if (Math.abs(last.x - first.x) < 0.001 && Math.abs(last.y - first.y) < 0.001) {
			points.pop();
		}
	}

	return points;
}

/** Shared vertex/primitive pool — LightBurn stores geometry in shared pools referenced by ID */
interface GeometryPool {
	verts: Map<string, Vertex[]>;
	prims: Map<string, Primitive[]>;
}

/** Scan the entire document for all VertList/PrimList data, indexed by VertID/PrimID */
function buildGeometryPool(root: Element): GeometryPool {
	const verts = new Map<string, Vertex[]>();
	const prims = new Map<string, Primitive[]>();

	const shapes = root.querySelectorAll('Shape[Type="Path"]');
	for (const shape of Array.from(shapes)) {
		const vertId = shape.getAttribute('VertID');
		const primId = shape.getAttribute('PrimID');

		const vertListEl = shape.querySelector(':scope > VertList');
		const primListEl = shape.querySelector(':scope > PrimList');

		if (vertId && vertListEl?.textContent) {
			// Only store the first definition (don't overwrite with empty)
			if (!verts.has(vertId)) {
				verts.set(vertId, parseVertList(vertListEl.textContent));
			}
		}

		if (primId && primListEl?.textContent) {
			if (!prims.has(primId)) {
				prims.set(primId, parsePrimList(primListEl.textContent));
			}
		}
	}

	return { verts, prims };
}

function processShape(
	el: Element,
	parentMatrix: AffineMatrix,
	parts: Part[],
	counter: { value: number },
	depth: number,
	pool: GeometryPool
): void {
	if (depth > MAX_DEPTH) return;

	const type = el.getAttribute('Type');
	if (!type) return;

	const localXForm = parseXForm(el);
	const matrix = multiplyMatrices(parentMatrix, localXForm);

	if (type === 'Group') {
		const children = el.querySelector(':scope > Children');
		if (children) {
			for (const child of Array.from(children.children)) {
				if (child.tagName === 'Shape') {
					processShape(child, matrix, parts, counter, depth + 1, pool);
				}
			}
		}
		return;
	}

	let polygons: Polygon[] = [];

	switch (type) {
		case 'Rect': {
			const w = parseFloat(el.getAttribute('W') ?? '0');
			const h = parseFloat(el.getAttribute('H') ?? '0');
			const raw: Polygon = [
				{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 },
				{ x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }
			];
			polygons = [applyMatrixToPolygon(matrix, raw)];
			break;
		}
		case 'Ellipse': {
			const rx = parseFloat(el.getAttribute('Rx') ?? '0');
			const ry = parseFloat(el.getAttribute('Ry') ?? '0');
			const raw: Polygon = [];
			for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
				const angle = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
				raw.push({ x: rx * Math.cos(angle), y: ry * Math.sin(angle) });
			}
			polygons = [applyMatrixToPolygon(matrix, raw)];
			break;
		}
		case 'Path': {
			// Try inline data first, fall back to shared pool
			const vertId = el.getAttribute('VertID');
			const primId = el.getAttribute('PrimID');

			const vertListEl = el.querySelector(':scope > VertList');
			const primListEl = el.querySelector(':scope > PrimList');

			const verts = vertListEl?.textContent
				? parseVertList(vertListEl.textContent)
				: (vertId ? pool.verts.get(vertId) ?? [] : []);

			const prims = primListEl?.textContent
				? parsePrimList(primListEl.textContent)
				: (primId ? pool.prims.get(primId) ?? [] : []);

			const poly = buildPolygonFromPrimitives(verts, prims);
			if (poly.length >= 3) {
				polygons = [applyMatrixToPolygon(matrix, poly)];
			}
			break;
		}
	}

	if (polygons.length > 0) {
		parts.push({ id: `part-${counter.value}`, name: `${type}-${counter.value}`, polygons, sourceIndex: counter.value });
		counter.value++;
	}
}

function getCutIndices(root: Element): Set<string> {
	const cutIndices = new Set<string>();
	for (const cs of Array.from(root.querySelectorAll('CutSetting'))) {
		const type = cs.getAttribute('type');
		if (type === 'Tool') continue;
		const indexEl = cs.querySelector('index');
		if (indexEl) {
			const val = indexEl.getAttribute('Value');
			if (val) cutIndices.add(val);
		}
	}
	return cutIndices;
}

export function parseLightBurn(xmlString: string): Part[] {
	if (xmlString.length > MAX_FILE_SIZE) {
		throw new Error(`LightBurn file too large (${(xmlString.length / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
	}

	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlString, 'text/xml');
	const root = doc.documentElement;
	const parts: Part[] = [];
	const counter = { value: 0 };

	const cutIndices = getCutIndices(root);
	const pool = buildGeometryPool(root);

	for (const child of Array.from(root.children)) {
		if (child.tagName === 'Shape') {
			const cutIndex = child.getAttribute('CutIndex');
			if (cutIndex && cutIndices.size > 0 && !cutIndices.has(cutIndex)) continue;
			processShape(child, IDENTITY, parts, counter, 0, pool);
		}
	}

	return parts;
}
