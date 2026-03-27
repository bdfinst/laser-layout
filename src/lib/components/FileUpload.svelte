<script lang="ts">
	import { parseSVG } from '$lib/parsers/svg-parser';
	import { parseLightBurn } from '$lib/parsers/lightburn-parser';
	import { projectStore } from '$lib/stores/project.svelte';
	import { MAX_FILE_SIZE } from '$lib/parsers/constants';

	let dragOver = $state(false);

	function handleFiles(files: FileList | null) {
		if (!files || files.length === 0) return;
		const file = files[0];
		if (file.size > MAX_FILE_SIZE) {
			alert(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const text = reader.result as string;
			const name = file.name;
			let parts;

			if (name.endsWith('.svg')) {
				parts = parseSVG(text);
			} else if (name.endsWith('.lbrn') || name.endsWith('.lbrn2')) {
				parts = parseLightBurn(text);
			} else {
				alert('Unsupported file format. Please use .svg, .lbrn, or .lbrn2');
				return;
			}

			if (parts.length === 0) {
				alert('No parts found in file.');
				return;
			}

			projectStore.setParts(parts, name);
		};
		reader.readAsText(file);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		handleFiles(e.dataTransfer?.files ?? null);
	}

	function onDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}

	function onDragLeave() {
		dragOver = false;
	}

	function onChange(e: Event) {
		const input = e.target as HTMLInputElement;
		handleFiles(input.files);
	}
</script>

<div
	class="upload-zone"
	class:drag-over={dragOver}
	ondrop={onDrop}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	role="button"
	tabindex="0"
>
	<input
		type="file"
		accept=".svg,.lbrn,.lbrn2"
		onchange={onChange}
		id="file-input"
		hidden
	/>
	<label for="file-input" class="upload-label">
		{#if projectStore.state.fileName}
			<span class="file-name">{projectStore.state.fileName}</span>
			<span class="hint">Click or drop to replace</span>
		{:else}
			<span class="icon">+</span>
			<span>Drop SVG or LightBurn file here</span>
			<span class="hint">or click to browse</span>
		{/if}
	</label>
</div>

<style>
	.upload-zone {
		border: 2px dashed #666;
		border-radius: 8px;
		padding: 2rem;
		text-align: center;
		cursor: pointer;
		transition: border-color 0.2s, background-color 0.2s;
	}

	.upload-zone:hover,
	.drag-over {
		border-color: #4a90d9;
		background-color: #f0f6ff;
	}

	.upload-label {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.95rem;
		color: #444;
	}

	.icon {
		font-size: 2rem;
		font-weight: bold;
		color: #888;
	}

	.hint {
		font-size: 0.8rem;
		color: #888;
	}

	.file-name {
		font-weight: 600;
		color: #2a6db0;
	}
</style>
