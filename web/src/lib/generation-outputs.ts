// Provider-neutral outputs: media uses owned resources; text is a durable task value.
export type GenerationOutput = {
    id: string;
    outputIndex: number;
    mediaType: "text" | "image" | "video" | "audio" | "file";
    text?: string;
    sourceNodeId?: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    resourceId?: string;
    assetId?: string;
    mimeType?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export function primaryGenerationOutput(outputs: GenerationOutput[], mode: string, selectedId?: string) {
    return outputs.find((item) => item.id === selectedId && item.mediaType === mode)
        || outputs.find((item) => item.mediaType === mode);
}

export function primaryTextGenerationOutput(outputs: GenerationOutput[], selectedId?: string, warning?: string) {
    const texts = outputs.filter((item) => item.mediaType === "text" && typeof item.text === "string" && item.text.trim());
    if (selectedId) return texts.find((item) => item.id === selectedId);
    if (!warning && texts.length === 1) return texts[0];
    return undefined;
}

export function generationTaskOutputReady(output: { mediaType: string; text?: string; resourceId?: string; materializedAssetId?: string; materializationErrorCode?: string }) {
    if (output.mediaType === "text") return typeof output.text === "string" && !!output.text.trim() && !output.materializationErrorCode;
    return !!output.materializedAssetId || output.mediaType === "file" && !!output.resourceId && !output.materializationErrorCode;
}
