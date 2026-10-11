// 转写由后端任务执行；前端只提交资源和模型 ID、观察任务状态，
// 并将成功结果转换为 SrtEntry[]，通过 rebuildSubtitleClips 原子替换字幕轨道快照。

import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Loader2 } from "lucide-react";

import { useEditorHostContext, useEditorStoreContext } from "@/components/editor/editor-context";
import {
    attachLocalExecutorResult,
    beginLocalExecutorSession,
    isLocalExecutorSessionStop,
    localExecutorFrozenInputKey,
    localExecutorIntentAfterError,
    localExecutorIntentAfterSubmit,
    nextLocalExecutorClientOperationId,
    runOwnedTimelineTranscription,
    type LocalExecutorIntentState,
} from "@/lib/plugins/builtin/editor/local-executor-session";
import { getSubtitleTracks } from "@/lib/timeline/timeline-tracks";
import { captureUserScope } from "@/lib/user-scope-guard";
import type { TimelineTranscriptionSegment } from "@/services/api/timeline-tasks";
import type { ProjectAsset } from "@/services/api/projects";
import type { SrtEntry } from "@/types/timeline";
import { getTranscriptionModels } from "@/services/api/timeline-tasks";
import type { ChannelModelCatalogItem } from "@/lib/channel-model-catalog";

const WHISPER_WAIT_TIMEOUT_MS = 25 * 60 * 1000;

// 上传素材的底层对象以 resource:<id> 形式存储在资源表，取其中的资源 ID 提交转写。
function resourceIdOfAsset(asset: ProjectAsset): string | null {
    const key = asset.storageKey ?? "";
    if (key.startsWith("resource:")) return key.slice("resource:".length);
    return null;
}

export function EditorTranscription() {
    const { assets, projectId } = useEditorHostContext();
    const { project, dispatch } = useEditorStoreContext();
    const mountedRef = useRef(true);
    const projectIdRef = useRef(projectId);
    const runningRef = useRef(false);
    const observationRef = useRef<AbortController | null>(null);
    const submitIntentRef = useRef<LocalExecutorIntentState | null>(null);
    const catalogRequestRef = useRef(0);
    projectIdRef.current = projectId;
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            observationRef.current?.abort();
        };
    }, []);
    useEffect(() => () => observationRef.current?.abort(), [projectId]);
    // 音频与视频素材均可转写（视频静音会由后端明确报错）。
    const transcribableAssets = useMemo(
        () => assets.filter((a) => a.mediaType === "audio" || a.mediaType === "video"),
        [assets],
    );
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const [progressLabel, setProgressLabel] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [model, setModel] = useState("");
    const [models, setModels] = useState<ChannelModelCatalogItem[]>([]);
    const [catalogError, setCatalogError] = useState("");
    const [catalogLoading, setCatalogLoading] = useState(false);
    const refreshModels = async () => {
        const requestID = ++catalogRequestRef.current;
        setCatalogLoading(true);
        setCatalogError("");
        setModels([]);
        setModel("");
        try {
            const result = await getTranscriptionModels({ expectedScope: captureUserScope() });
            if (!mountedRef.current || catalogRequestRef.current !== requestID) return;
            setModels(result);
            setModel(current => result.some(item => item.id === current) ? current : "");
            if (!result.length) setCatalogError("当前连接没有可用的云端转写模型");
        } catch (error) {
            if (mountedRef.current && catalogRequestRef.current === requestID) setCatalogError(error instanceof Error ? error.message : "读取转写模型失败");
        } finally {
            if (mountedRef.current && catalogRequestRef.current === requestID) setCatalogLoading(false);
        }
    };

    useEffect(() => {
        if (selectedId === null && transcribableAssets.length > 0) {
            const firstAudio = transcribableAssets.find((a) => a.mediaType === "audio");
            setSelectedId((firstAudio ?? transcribableAssets[0]).id);
        }
    }, [transcribableAssets, selectedId]);

    if (!project) return null;
    const subtitleTrack = getSubtitleTracks(project.tracks)[0];
    const selected = transcribableAssets.find((a) => a.id === selectedId) ?? null;

    const toSrtEntries = (segments: TimelineTranscriptionSegment[]): SrtEntry[] =>
        segments
            .map((seg, i) => ({
                index: i + 1,
                startMs: seg.startMs,
                endMs: seg.endMs,
                text: seg.text,
            }))
            .filter((entry) => entry.text.trim() !== "" && entry.endMs > entry.startMs);

    const transcribe = async () => {
        if (!selected || runningRef.current) return;
        const resourceId = resourceIdOfAsset(selected);
        if (!resourceId) {
            setFailed(true);
            setMessage("该素材没有可转写的媒体对象（缺少 storageKey）");
            return;
        }
        runningRef.current = true;
        const expectedScope = captureUserScope();
        const originalProjectId = projectId;
        const originalTrackId = subtitleTrack?.id;
        const originalSelectedId = selected.id;
        const originalDispatch = dispatch;
        const observer = new AbortController();
        observationRef.current?.abort();
        observationRef.current = observer;
        const frozenInputKey = localExecutorFrozenInputKey(["timeline_transcription", originalProjectId, resourceId, model]);
        const clientOperationId = nextLocalExecutorClientOperationId(submitIntentRef.current, frozenInputKey);
        submitIntentRef.current = { clientOperationId, frozenInputKey };
        setRunning(true);
        setFailed(false);
        setMessage(null);
        setProgressLabel("排队中…");
        try {
            const session = beginLocalExecutorSession(originalProjectId, {
                controller: observer,
                getLiveProjectId: () => projectIdRef.current,
                expectedScope,
            });
            const { task, result } = await runOwnedTimelineTranscription({
                session,
                resourceId,
                model: model || undefined,
                projectId: originalProjectId,
                clientOperationId,
                timeoutMs: WHISPER_WAIT_TIMEOUT_MS,
                intervalMs: 2000,
                onCreated: (created) => {
                    submitIntentRef.current = localExecutorIntentAfterSubmit(clientOperationId, created, submitIntentRef.current ?? { clientOperationId, frozenInputKey });
                },
                onTaskUpdate: (next) => {
                    const stage = next.stage;
                    const progress = next.progress ?? 0;
                    if (stage) setProgressLabel(`${stage}${progress > 0 && progress < 100 ? ` ${progress}%` : ""}`);
                },
            });
            submitIntentRef.current = localExecutorIntentAfterSubmit(clientOperationId, task, submitIntentRef.current ?? { clientOperationId, frozenInputKey });
            const entries = toSrtEntries(result.segments ?? []);
            await attachLocalExecutorResult(session, () => {
                if (entries.length === 0) {
                    setMessage("转写完成，但没有识别出可用字幕（语音内容为空？）");
                } else if (!originalTrackId) {
                    setMessage("项目没有字幕轨道，无法写入转写字幕");
                } else {
                    originalDispatch({
                        op: "rebuildSubtitleClips",
                        payload: { nodeId: `transcription:${originalSelectedId}`, entries, trackId: originalTrackId },
                    });
                    const langHint = result.language ? `（${result.language}）` : "";
                    setMessage(`已写入 ${entries.length} 条转写字幕${langHint}`);
                }
                setProgressLabel(null);
            });
        } catch (err) {
            if (isLocalExecutorSessionStop(err)) {
                if (mountedRef.current) {
                    setRunning(false);
                    setProgressLabel(null);
                }
                return;
            }
            submitIntentRef.current = localExecutorIntentAfterError(submitIntentRef.current ?? { clientOperationId, frozenInputKey }, err);
            setFailed(true);
            setMessage(err instanceof Error ? err.message : "转写失败，请稍后重试");
            setProgressLabel(null);
        } finally {
            runningRef.current = false;
            if (mountedRef.current) setRunning(false);
        }
    };

    return (
        <div className="flex h-full flex-col bg-[var(--director-sequencer-surface)]">
            <div className="director-scroll min-h-0 flex-1 overflow-y-auto p-3">
                {transcribableAssets.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
                        <AudioLines className="size-5 text-[var(--director-dock-fg)]/40" />
                        <p className="text-xs text-[var(--director-dock-fg)]/60">项目暂无音视频素材</p>
                        <p className="max-w-[200px] text-[11px] leading-relaxed text-[var(--director-dock-fg)]/45">素材库加入音频或视频后可转写自动字幕</p>
                    </div>
                ) : (
                    <>
                        <label className="mb-2 block">
                            <span className="mb-1 block text-[11px] text-[var(--director-dock-fg)]/70">转写模型</span>
                            <select aria-label="转写模型" value={model} disabled={running} onChange={event => setModel(event.target.value)} className="w-full rounded-md border border-[var(--director-sequencer-border)] bg-[var(--director-control-hover)] px-2 py-1.5 text-xs text-[var(--director-dock-fg-strong)]">
                                <option value="">本地 whisper.cpp</option>
                                {models.map(item => <option key={item.id} value={item.id}>{item.displayName || item.id} · BeefTV</option>)}
                            </select>
                        </label>
                        <button type="button" disabled={catalogLoading || running} onClick={() => void refreshModels()} className="mb-2 text-xs text-[var(--director-dock-fg)] disabled:opacity-40">{catalogLoading ? "读取中…" : "读取 BeefTV 转写模型"}</button>
                        {catalogError && <p role="alert" className="mb-2 text-xs text-[var(--director-danger)]">{catalogError}</p>}
                        <label className="mb-2 block">
                            <span className="mb-1 block text-[11px] text-[var(--director-dock-fg)]/70">音视频素材</span>
                            <select
                                value={selectedId ?? ""}
                                onChange={(e) => setSelectedId(e.target.value)}
                                className="w-full rounded-md border border-[var(--director-sequencer-border)] bg-[var(--director-control-hover)] px-2 py-1.5 text-xs text-[var(--director-dock-fg-strong)] outline-none focus:border-[var(--workspace-accent)]/60 [&>option]:bg-[var(--director-sequencer-surface-raised)] [&>option]:text-[var(--director-dock-fg-strong)]"
                            >
                                {transcribableAssets.map((a) => (
                                    <option key={a.id} value={a.id}>
                                        {a.title || a.storageKey}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <button
                            type="button"
                            onClick={transcribe}
                            disabled={!selected || running}
                            className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--director-accent)] px-2 py-1.5 text-xs font-medium text-[var(--director-on-accent)] hover:bg-[var(--director-accent-hover)] disabled:opacity-40"
                        >
                            {running && <Loader2 className="size-3.5 animate-spin" />}
                            {running ? "转写中…" : "转写自动字幕"}
                        </button>

                        {running && progressLabel && (
                            <p className="mt-2 text-[11px] text-[var(--director-dock-fg)]/60">{progressLabel}</p>
                        )}
                        {message && (
                            <p className={`mt-2 text-[11px] ${failed ? "text-[var(--director-danger)]" : "text-[var(--director-dock-fg)]/70"}`}>
                                {message}
                            </p>
                        )}
                        <p className="mt-2 text-[11px] leading-relaxed text-[var(--director-dock-fg)]/45">
                            {model ? "音频将上传到 BeefTV 云端识别，并按所选模型计费；结果写入字幕轨道，可再编辑。" : "由本地 whisper.cpp 识别，音视频不出本机；识别结果写入字幕轨道，可再编辑。"}
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
