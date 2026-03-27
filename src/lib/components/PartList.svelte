<script lang="ts">
	import { projectStore, toDisplayUnits } from '$lib/stores/project.svelte';
	import { boundingBox, toSVGPathD } from '$lib/geometry/polygon';

	function onQuantityChange(partId: string, e: Event) {
		const input = e.target as HTMLInputElement;
		projectStore.setQuantity(partId, parseInt(input.value) || 0);
	}

	function fmtSize(mm: number): string {
		const u = projectStore.state.units;
		const prec = u === 'in' ? 2 : 1;
		return toDisplayUnits(mm, u).toFixed(prec);
	}

	function totalParts(): number {
		let total = 0;
		for (const qty of projectStore.state.quantities.values()) {
			total += qty;
		}
		return total;
	}

	function thumbViewBox(bb: { minX: number; minY: number; width: number; height: number }): string {
		const pad = Math.max(bb.width, bb.height) * 0.08;
		return `${bb.minX - pad} ${bb.minY - pad} ${bb.width + pad * 2} ${bb.height + pad * 2}`;
	}

	const THUMB_SIZE = 48;
</script>

{#if projectStore.state.parts.length > 0}
	<div class="part-list">
		<h3>Parts ({totalParts()} total)</h3>
		<div class="parts">
			{#each projectStore.state.parts as part (part.id)}
				{@const bb = boundingBox(part.polygons[0])}
				<div class="part-row">
					<div class="thumb">
						<svg
							width={THUMB_SIZE}
							height={THUMB_SIZE}
							viewBox={thumbViewBox(bb)}
							xmlns="http://www.w3.org/2000/svg"
						>
							{#each part.polygons as poly, polyIdx (polyIdx)}
								<path
									d={toSVGPathD(poly)}
									fill="#4a90d922"
									stroke="#4a90d9"
									stroke-width={Math.max(bb.width, bb.height) * 0.02}
								/>
							{/each}
						</svg>
					</div>
					<div class="info">
						<span class="name" title={part.name}>{part.name}</span>
						<span class="size">{fmtSize(bb.width)} x {fmtSize(bb.height)} {projectStore.state.units}</span>
					</div>
					<div class="qty">
						<input
							type="number"
							min="0"
							max="100"
							value={projectStore.state.quantities.get(part.id) ?? 1}
							onchange={(e) => onQuantityChange(part.id, e)}
						/>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.part-list {
		margin-top: 1rem;
	}

	h3 {
		margin: 0 0 0.5rem 0;
		font-size: 1rem;
		color: #333;
	}

	.parts {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.part-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.5rem;
		border: 1px solid #eee;
		border-radius: 6px;
		background: #fff;
	}

	.part-row:hover {
		background: #f8fafc;
		border-color: #ddd;
	}

	.thumb {
		flex-shrink: 0;
		background: #fafafa;
		border-radius: 4px;
		border: 1px solid #eee;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.name {
		font-size: 0.85rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.size {
		color: #888;
		font-family: monospace;
		font-size: 0.75rem;
	}

	.qty input {
		width: 3.5rem;
		padding: 0.2rem 0.3rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		text-align: center;
		font-size: 0.85rem;
	}
</style>
