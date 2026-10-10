import { useState } from "react";
import { Button } from "antd";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { generationOutputMetadata } from "@/lib/canvas/canvas-generation-outputs";
import type { GenerationOutput } from "@/lib/generation-outputs";
import type { CanvasNodeData } from "@/types/canvas";
import { useCanvasNodeActions } from "./canvas-node-action-context";

export function CanvasGenerationResults({ node }: { node: CanvasNodeData }) {
    const [open, setOpen] = useState(false);
    const [previewId, setPreviewId] = useState<string>();
    const { updateMetadata, addGenerationOutputs } = useCanvasNodeActions();
    const outputs = node.metadata?.generationOutputs || [];
    if (!outputs.length) return null;
    const preview = outputs.find((item) => item.id === previewId) || outputs.find((item) => item.id === node.metadata?.primaryOutputId) || outputs[0];
    return <>
        <Button size="small" className="absolute bottom-2 right-2 z-[var(--node-z-overlay)]" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setOpen(true); }}>结果 · {outputs.length}</Button>
        <AppDrawer title={`生成结果 · ${outputs.length}`} open={open} onClose={() => setOpen(false)} size={480}>
            <div className="flex flex-col gap-4 text-foreground" data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                <OutputPreview key={preview.id} output={preview} />
                <p className="text-xs" style={{ color: "var(--workspace-text-muted)" }}>切换预览不会改变画布连接。设为主输出后，下游使用当前节点的新结果；添加到画布可单独连接其他输出。</p>
                {outputs.map((output) => {
                    const url = outputURL(output);
                    const primary = output.id === node.metadata?.primaryOutputId;
                    return <div key={output.id} className="flex flex-col gap-2 rounded-lg p-3" style={{ background: "var(--card-surface)" }}>
                        <button type="button" className="text-left text-sm" aria-pressed={preview.id === output.id} onClick={() => setPreviewId(output.id)}>输出 {output.outputIndex + 1} · {output.mediaType === "video" ? "视频" : output.mediaType === "audio" ? "音频" : output.mediaType === "image" ? "图片" : "文件"}{output.sourceNodeId ? ` · 节点 ${output.sourceNodeId}` : ""}{primary ? " · 主输出" : ""}</button>
                        <div className="flex flex-wrap gap-2">
                            {output.mediaType === node.type && updateMetadata ? <Button size="small" disabled={primary} onClick={() => updateMetadata(node.id, generationOutputMetadata(output))}>设为主输出</Button> : null}
                            {output.mediaType !== "file" && addGenerationOutputs ? <Button size="small" onClick={() => addGenerationOutputs(node, [output])}>添加到画布</Button> : null}
                            {url ? <a href={url} download={`output-${output.outputIndex + 1}`} className="text-xs">下载</a> : null}
                        </div>
                    </div>;
                })}
                {addGenerationOutputs ? <Button onClick={() => addGenerationOutputs(node, outputs)}>将全部媒体添加到画布</Button> : null}
            </div>
        </AppDrawer>
    </>;
}

function outputURL(output: GenerationOutput) {
    const resourceId = resourceIdFromStorageKey(output.storageKey);
    return resourceId ? resourceFileUrl(resourceId) : output.dataUrl || output.url || "";
}

function OutputPreview({ output }: { output: GenerationOutput }) {
    if (output.mediaType === "video") return <OutputVideoPreview output={output} />;
    if (output.mediaType === "image") return <CachedResourceImage className="max-h-72 w-full object-contain" src={outputURL(output)} storageKey={output.storageKey} alt={`输出 ${output.outputIndex + 1}`} />;
    if (output.mediaType === "audio") return <audio controls src={outputURL(output)} className="w-full" />;
    return <p className="text-sm">{output.mimeType || "文件"} · 请下载查看</p>;
}

function OutputVideoPreview({ output }: { output: GenerationOutput }) {
    const playback = useResourceVideoPlayback(output.storageKey || "", outputURL(output));
    return <div>
        {playback.url ? <video key={`${playback.url}:${playback.retryEpoch}`} controls playsInline preload="auto" src={playback.url} className="max-h-72 w-full" onError={() => { if (!playback.requestCompatible()) playback.fail(); }} /> : null}
        {playback.loading ? <p role="status">正在读取视频…</p> : null}
        {playback.error ? <div role="alert">{playback.error}<Button size="small" onClick={playback.retry}>重新读取</Button></div> : null}
    </div>;
}
