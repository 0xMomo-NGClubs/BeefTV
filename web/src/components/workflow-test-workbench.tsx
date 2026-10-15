import { App, Button, Input, InputNumber, Progress, Select } from "antd";
import { Switch } from "@/components/ui/base/switch";
import { EmptyState } from "@/components/ui/product/empty-state";
import { FileAudio, FileImage, FileText, Film, Grip, Play, RefreshCw, RotateCcw, Square, Upload, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { generationErrorMessage } from "@/lib/generation-error";
import { primaryGenerationOutput, primaryTextGenerationOutput } from "@/lib/generation-outputs";
import { GenerationTextOutput } from "@/components/generation/generation-text-output";
import { GenerationAudioOutput } from "@/components/generation/generation-audio-output";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { downloadGenerationOutput } from "@/services/generation-output-media";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { parseBackendGenerationResult, runBackendGenerationTask, type BackendGenerationResult } from "@/services/api/generation-task";
import { queryProviderTaskResult, type GenerationTask } from "@/services/api/task-center";
import { latestWorkflowTestTask, rememberWorkflowTestTask } from "@/services/workflow-test-task";
import { getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { captureUserScope } from "@/lib/user-scope-guard";
import { useConfigStore, type AiConfig, type RunningHubCapability, type WorkflowFieldMapping } from "@/stores/use-config-store";
import { workflowPromptTargetLabel, workflowPromptTargets } from "@/lib/workflow-prompt-mapping";
import { WorkflowInputPlan } from "@/components/workflow-input-plan";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type WorkflowProvider = "runninghub";
type MediaKind = "image" | "video" | "audio";
type Point = { x: number; y: number };
type NodePositionMap = Record<string, Point>;
type TestFile = { id: string; file: File; url: string };

type WorkflowTestWorkbenchProps = {
    provider: WorkflowProvider;
    workflowId: string;
    workflowKind?: "workflow" | "app";
    title: string;
    capability: RunningHubCapability;
    fields: WorkflowFieldMapping[];
    disabled?: boolean;
    disabledReason?: string;
};

const initialPositions: NodePositionMap = {
    prompt: { x: 36, y: 46 },
    image: { x: 36, y: 244 },
    video: { x: 36, y: 410 },
    audio: { x: 36, y: 576 },
    workflow: { x: 382, y: 132 },
    output: { x: 758, y: 188 },
};

export function WorkflowTestWorkbench({ provider, workflowId, workflowKind = "workflow", title, capability, fields, disabled = false, disabledReason }: WorkflowTestWorkbenchProps) {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const [prompt, setPrompt] = useState("");
    const [files, setFiles] = useState<Record<MediaKind, TestFile[]>>({ image: [], video: [], audio: [] });
    const [fieldValues, setFieldValues] = useState<Record<string, unknown>>(() => initialFieldValues(fields, config));
    const [positions, setPositions] = useState<NodePositionMap>(initialPositions);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState(0);
    const [stage, setStage] = useState("等待运行");
    const [result, setResult] = useState<BackendGenerationResult | null>(null);
    const [previewOutputId, setPreviewOutputId] = useState("");
    const [error, setError] = useState("");
    const [task, setTask] = useState<GenerationTask | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const scopeEpoch = useSyncExternalStore(subscribeUserScope, getActiveUserScopeEpoch, getActiveUserScopeEpoch);
    const taskRef = useRef<GenerationTask | null>(null);
    const refreshRef = useRef<AbortController | null>(null);
    const lookupRef = useRef<AbortController | null>(null);
    const canvasRef = useRef<HTMLDivElement>(null);
    const autoOutputXRef = useRef(initialPositions.output.x);
    const [canvasWidth, setCanvasWidth] = useState(1040);
    const abortRef = useRef<AbortController | null>(null);
    const filesRef = useRef(files);

    const activeFields = useMemo(() => fields.filter((field) => field.enabled !== false), [fields]);
    const slots = useMemo(() => mediaSlotCounts(activeFields), [activeFields]);
    const imageReferenceCount = useMemo(() => referenceImageSlotCount(activeFields), [activeFields]);
    const maskEnabled = useMemo(() => activeFields.some((field) => field.source === "mask"), [activeFields]);
    const parameterFields = useMemo(() => uniqueParameterFields(activeFields), [activeFields]);
    const promptTarget = workflowPromptTargetLabel(fields);
    const selectedWorkflow = config.runningHub.workflows.find((item) => item.workflowId === workflowId && (item.kind === "app" ? "app" : "workflow") === workflowKind);
    const visibleMediaKinds = (Object.keys(slots) as MediaKind[]).filter((kind) => slots[kind] > 0);
    const resultOutputs = result?.outputs || [];
    const initialOutput = capability === "text" ? primaryTextGenerationOutput(resultOutputs, result?.primaryOutputId, result?.outputParameterWarning) : primaryGenerationOutput(resultOutputs, capability);
    const previewOutput = resultOutputs.find((output) => output.id === previewOutputId) || initialOutput || resultOutputs[0];
    const previewCapability = previewOutput?.mediaType || capability;
    const resultUrls = previewOutput ? [previewOutput.dataUrl || previewOutput.url || ""].filter(Boolean) : generationResultUrls(result, capability);

    const showTask = (next: GenerationTask, providerStatus = next.status as string) => {
        taskRef.current = next;
        setTask(next);
        setProgress(Number(next.progress) || 0);
        if (next.status === "succeeded") {
            setResult(parseBackendGenerationResult(next));
            setError("");
            setStage("已完成");
        } else if (providerStatus === "running" || providerStatus === "queued") {
            setError("");
            setStage(providerStatus === "queued" ? "上游任务排队中，可稍后刷新结果" : "上游任务运行中，可稍后刷新结果");
        } else {
            setStage(taskStageLabel(next.status, next.stage));
            setError(next.status === "failed" ? generationErrorMessage(next.error || "任务失败") : "");
        }
    };

    useEffect(() => {
        const controller = new AbortController();
        lookupRef.current = controller;
        taskRef.current = null;
        setTask(null);
        setRefreshing(false);
        setRunning(false);
        setPrompt("");
        Object.values(filesRef.current).flat().forEach((file) => URL.revokeObjectURL(file.url));
        setFiles({ image: [], video: [], audio: [] });
        void latestWorkflowTestTask({ workflowId, kind: workflowKind, capability }, controller.signal).then((latest) => {
            if (latest && !controller.signal.aborted && !taskRef.current) showTask(latest);
        }).catch((reason) => {
            if (!controller.signal.aborted) message.warning(reason instanceof Error ? `读取最近测试任务失败：${reason.message}` : "读取最近测试任务失败");
        });
        return () => { controller.abort(); abortRef.current?.abort(); abortRef.current = null; refreshRef.current?.abort(); refreshRef.current = null; };
    }, [workflowId, workflowKind, capability, scopeEpoch]);

    useEffect(() => {
        setFieldValues(initialFieldValues(fields, config));
        setResult(null);
        setError("");
        setProgress(0);
        setStage("等待运行");
    }, [workflowId, workflowKind, fields, config.size, config.quality, config.vquality]);

    useEffect(() => {
        filesRef.current = files;
    }, [files]);

    useEffect(() => {
        const canvas = canvasRef.current;
        const scroll = canvas?.parentElement;
        if (!scroll) return;
        const measure = () => setCanvasWidth(Math.max(1040, scroll.clientWidth));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(scroll);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const nextOutputX = Math.max(758, canvasWidth - 324 - 36);
        setPositions((current) => {
            // 用户手动拖动过输出节点后尊重其位置，不再被窗口尺寸变化覆盖。
            if (current.output.x !== autoOutputXRef.current || current.output.x === nextOutputX) return current;
            autoOutputXRef.current = nextOutputX;
            return { ...current, output: { ...current.output, x: nextOutputX } };
        });
    }, [canvasWidth]);

    useEffect(
        () => () => {
            abortRef.current?.abort();
            refreshRef.current?.abort();
            Object.values(filesRef.current)
                .flat()
                .forEach((item) => URL.revokeObjectURL(item.url));
        },
        [],
    );

    const replaceFiles = (kind: MediaKind, selected: FileList | null) => {
        if (!selected?.length) return;
        const limit = Math.max(1, slots[kind]);
        const next = Array.from(selected)
            .slice(0, limit)
            .map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
        setFiles((current) => {
            current[kind].forEach((item) => URL.revokeObjectURL(item.url));
            return { ...current, [kind]: next };
        });
    };

    const resetTest = () => {
        lookupRef.current?.abort();
        Object.values(files)
            .flat()
            .forEach((item) => URL.revokeObjectURL(item.url));
        setFiles({ image: [], video: [], audio: [] });
        setPrompt("");
        setFieldValues(initialFieldValues(fields, config));
        const nextOutputX = Math.max(758, canvasWidth - 324 - 36);
        autoOutputXRef.current = nextOutputX;
        setPositions({ ...initialPositions, output: { ...initialPositions.output, x: nextOutputX } });
        setResult(null);
        setError("");
        setProgress(0);
        setStage("等待运行");
        taskRef.current = null;
        setTask(null);
    };

    const runTest = async () => {
        if (disabled) return message.warning(disabledReason || "请先完成工作流配置");
        const missing = missingRequiredInput(activeFields, files, fieldValues);
        if (missing) return message.warning(missing);
        lookupRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        taskRef.current = null;
        setTask(null);
        setRunning(true);
        setResult(null);
        setError("");
        setProgress(0);
        setStage("正在提交任务");
        try {
            const testConfig = buildTestConfig(config, provider, workflowId, workflowKind, activeFields, fieldValues);
            const response = await runBackendGenerationTask({
                mode: capability,
                prompt,
                config: testConfig,
                referenceImages: files.image.slice(0, imageReferenceCount).map(toReferenceImage),
                referenceVideos: files.video.map(toReferenceVideo),
                referenceAudios: files.audio.map(toReferenceAudio),
                mask: maskEnabled && files.image[imageReferenceCount] ? toReferenceImage(files.image[imageReferenceCount]) : undefined,
                signal: controller.signal,
                expectedScope: captureUserScope(),
                metadata: { source: "workflow_settings_test", workflowProvider: provider, workflowId, workflowKind },
                onTaskUpdate: (task) => {
                    if (taskRef.current?.id !== task.id) {
                        void rememberWorkflowTestTask({ workflowId, kind: workflowKind, capability }, task.id).catch(() => {
                            if (!controller.signal.aborted) message.warning("任务已创建，但最近测试记录未缓存；可在生成历史中查询");
                        });
                    }
                    taskRef.current = task;
                    setTask(task);
                    setProgress(Math.max(0, Math.min(100, Number(task.progress) || 0)));
                    setStage(taskStageLabel(task.status, task.stage));
                },
            });
            setResult(response);
            setPreviewOutputId("");
            setProgress(100);
            setStage("测试完成");
            message.success("工作流测试完成");
        } catch (reason) {
            if (abortRef.current !== controller) return;
            if (controller.signal.aborted) {
                setStage("已停止等待");
                return;
            }
            const detail = generationErrorMessage(reason);
            setError(detail);
            setStage("测试失败");
            message.error(detail);
        } finally {
            if (abortRef.current === controller) {
                abortRef.current = null;
                setRunning(false);
            }
        }
    };

    const stopTest = () => {
        abortRef.current?.abort();
        setStage("正在停止等待");
    };

    const refreshResult = async () => {
        if (!taskRef.current || refreshRef.current) return;
        const request = new AbortController();
        refreshRef.current = request;
        setRefreshing(true);
        try {
            const queried = await queryProviderTaskResult(taskRef.current.id, { signal: request.signal });
            if (!request.signal.aborted) showTask(queried.task, queried.providerStatus);
        } catch (reason) {
            if (!request.signal.aborted) message.error(generationErrorMessage(reason));
        } finally {
            if (refreshRef.current === request) refreshRef.current = null;
            if (!request.signal.aborted) setRefreshing(false);
        }
    };

    return (
        <div className="workflow-test-workbench">
            <div className="workflow-test-toolbar">
                <div className="min-w-0">
                    <strong>{title || workflowId || "未选择工作流"}</strong>
                    <span>
                        RunningHub · {capabilityName(capability)}工作流 · 测试值不会覆盖保存配置
                    </span>
                </div>
                <div className="workflow-test-toolbar-actions">
                    <Button icon={<RefreshCw className="size-4" />} loading={refreshing} disabled={!task} title="查询原任务结果，不重新生成" onClick={() => void refreshResult()}>刷新结果</Button>
                    <Button icon={<RotateCcw className="size-4" />} disabled={running || refreshing} onClick={resetTest}>
                        重置测试
                    </Button>
                    {running ? (
                        <Button danger icon={<Square className="size-4" />} onClick={stopTest}>
                            停止等待
                        </Button>
                    ) : (
                        <Button type="primary" icon={<Play className="size-4" />} disabled={disabled || refreshing || task?.status === "running" || task?.status === "queued"} onClick={() => void runTest()}>
                            运行测试
                        </Button>
                    )}
                </div>
            </div>
            {disabled && disabledReason ? <div className="workflow-test-notice">{disabledReason}</div> : null}
            <div className="workflow-test-canvas-scroll">
                <div ref={canvasRef} className="workflow-test-canvas" data-canvas-no-zoom>
                    <svg className="workflow-test-lines" aria-hidden="true" viewBox={`0 0 ${canvasWidth} 760`} preserveAspectRatio="none">
                        {promptTarget ? <WorkflowLine from={positions.prompt} to={positions.workflow} fromWidth={284} toOffsetY={74} /> : null}
                        {visibleMediaKinds.map((kind, index) => (
                            <WorkflowLine key={kind} from={positions[kind]} to={positions.workflow} fromWidth={284} fromOffsetY={64} toOffsetY={112 + index * 26} />
                        ))}
                        <WorkflowLine from={positions.workflow} to={positions.output} fromWidth={324} fromOffsetY={84} toOffsetY={70} />
                    </svg>

                    <WorkflowNode id="prompt" title="提示词" icon={<WandSparkles />} position={positions.prompt} onMove={(point) => setPositions((current) => ({ ...current, prompt: point }))}>
                        <p className="mb-2 break-words text-xs text-muted-foreground">{promptTarget ? `提交到：${promptTarget}` : "未映射提示词，使用右侧工作流字段值"}</p>
                        <Input.TextArea value={prompt} autoSize={{ minRows: 4, maxRows: 7 }} placeholder="输入本次测试提示词" onChange={(event) => setPrompt(event.target.value)} />
                    </WorkflowNode>

                    {visibleMediaKinds.map((kind) => (
                        <WorkflowNode
                            key={kind}
                            id={kind}
                            title={`${kind === "image" && maskEnabled ? "图片 / 蒙版" : mediaName(kind)}素材 · ${slots[kind]} 个槽位`}
                            icon={mediaIcon(kind)}
                            position={positions[kind]}
                            onMove={(point) => setPositions((current) => ({ ...current, [kind]: point }))}
                        >
                            <MediaPicker kind={kind} limit={slots[kind]} files={files[kind]} maskIndex={kind === "image" && maskEnabled ? imageReferenceCount : undefined} onChange={(selected) => replaceFiles(kind, selected)} />
                            <div className="mt-2 text-muted-foreground"><WorkflowInputPlan workflow={selectedWorkflow} fields={fields} kind={kind} counts={{ image: Math.min(files.image.length, imageReferenceCount), video: files.video.length, audio: files.audio.length }} /></div>
                        </WorkflowNode>
                    ))}

                    <WorkflowNode id="workflow" title={title || "工作流动态参数"} icon={<Grip />} position={positions.workflow} wide onMove={(point) => setPositions((current) => ({ ...current, workflow: point }))}>
                        <div className="workflow-test-parameters">
                            {parameterFields.length ? (
                                parameterFields.map((field) => {
                                    const key = testFieldKey(field);
                                    return <WorkflowParameter key={key} field={field} value={fieldValues[key]} onChange={(value) => setFieldValues((current) => ({ ...current, [key]: value }))} />;
                                })
                            ) : (
                                <span className="workflow-test-empty-text">此工作流没有额外动态参数</span>
                            )}
                        </div>
                    </WorkflowNode>

                    <WorkflowNode
                        id="output"
                        title={`${capabilityName(capability)}输出`}
                        icon={capability === "text" ? <FileText /> : capability === "image" ? <FileImage /> : capability === "video" ? <Film /> : <FileAudio />}
                        position={positions.output}
                        onMove={(point) => setPositions((current) => ({ ...current, output: point }))}
                    >
                        {resultOutputs.length > 1 ? <Select className="mb-2 w-full" value={previewOutput?.id} options={resultOutputs.map((output) => ({ value: output.id, label: `${output.mediaType === "file" ? "文件" : capabilityName(output.mediaType)} · 输出 ${output.outputIndex + 1}${output.sourceNodeId ? ` · 节点 ${output.sourceNodeId}` : ""}` }))} onChange={setPreviewOutputId} /> : null}
                        {result?.outputParameterWarning ? <p className="mb-2 text-xs text-muted-foreground">{result.outputParameterWarning}</p> : null}
                        <div className="workflow-test-output">{previewOutput?.mediaType === "text" ? <GenerationTextOutput text={previewOutput.text || ""} /> : previewOutput?.mediaType === "audio" ? <GenerationAudioOutput output={previewOutput} /> : resultUrls.length && previewCapability !== "text" && previewCapability !== "file" ? <ResultPreview capability={previewCapability} urls={resultUrls} video={previewOutput?.mediaType === "video" ? previewOutput : result?.video} /> : <EmptyState size="compact" title={error || (previewCapability === "file" ? "请下载查看文件" : stage)} />}</div>
                        {previewOutput ? <Button className="mt-2" size="small" onClick={() => void downloadGenerationOutput(previewOutput).catch((reason) => message.error(reason instanceof Error ? reason.message : "下载失败"))}>下载{previewOutput.mediaType === "text" ? " TXT" : "输出"}</Button> : null}
                        <Progress percent={progress} size="small" status={error ? "exception" : running ? "active" : undefined} showInfo={running || progress > 0} />
                    </WorkflowNode>
                </div>
            </div>
        </div>
    );
}

function WorkflowNode({ id, title, icon, position, onMove, wide = false, children }: { id: string; title: string; icon: ReactNode; position: Point; onMove: (point: Point) => void; wide?: boolean; children: ReactNode }) {
    const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
    const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const target = event.currentTarget.parentElement;
        const canvas = target?.parentElement;
        if (!target || !canvas) return;
        const rect = target.getBoundingClientRect();
        dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
        const canvas = event.currentTarget.parentElement?.parentElement;
        const node = event.currentTarget.parentElement;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const width = wide ? 324 : 284;
        const height = node?.offsetHeight || 92;
        onMove({ x: Math.max(12, Math.min(rect.width - width - 12, event.clientX - rect.left - dragRef.current.offsetX)), y: Math.max(12, Math.min(rect.height - height - 12, event.clientY - rect.top - dragRef.current.offsetY)) });
    };
    const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };
    return (
        <section className={`workflow-test-node${wide ? " is-wide" : ""}`} style={{ transform: `translate(${position.x}px, ${position.y}px)` }} data-node-id={id}>
            <div className="workflow-test-node-header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}>
                <span>{icon}</span>
                <strong title={title}>{title}</strong>
                <Grip className="workflow-test-node-grip" />
            </div>
            <div className="workflow-test-node-body">{children}</div>
            <i className="workflow-test-port is-input" />
            <i className="workflow-test-port is-output" />
        </section>
    );
}

function WorkflowLine({ from, to, fromWidth, fromOffsetY = 54, toOffsetY }: { from: Point; to: Point; fromWidth: number; fromOffsetY?: number; toOffsetY: number }) {
    const x1 = from.x + fromWidth;
    const y1 = from.y + fromOffsetY;
    const x2 = to.x;
    const y2 = to.y + toOffsetY;
    const curve = Math.max(52, Math.abs(x2 - x1) * 0.46);
    return <path d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`} />;
}

function MediaPicker({ kind, limit, files, maskIndex, onChange }: { kind: MediaKind; limit: number; files: TestFile[]; maskIndex?: number; onChange: (files: FileList | null) => void }) {
    return (
        <label className="workflow-test-upload">
            <input
                type="file"
                hidden
                multiple={limit > 1}
                accept={kind === "image" ? "image/*" : kind === "video" ? "video/*" : "audio/*"}
                onChange={(event) => {
                    onChange(event.target.files);
                    event.currentTarget.value = "";
                }}
            />
            {files.length ? (
                <div className="workflow-test-file-list">
                    {files.map((item, index) => (
                        <span key={item.id} title={item.file.name}>
                            {kind === "image" ? <img src={item.url} alt="" /> : mediaIcon(kind)}
                            <b>{maskIndex === index ? "蒙版" : index + 1}</b>
                            <em>{item.file.name}</em>
                        </span>
                    ))}
                </div>
            ) : (
                <span>
                    <Upload />
                    选择{mediaName(kind)}（最多 {limit} 个）
                </span>
            )}
        </label>
    );
}

function WorkflowParameter({ field, value, onChange }: { field: WorkflowFieldMapping; value: unknown; onChange: (value: unknown) => void }) {
    const label = field.label || field.fieldName;
    const type = String(field.fieldType || "").toUpperCase();
    if (field.randomEnabled && !field.source)
        return (
            <label>
                <span title={`${field.nodeId}.${field.fieldName}`}>
                    {label}
                    <small>
                        {field.nodeId}.{field.fieldName}
                    </small>
                </span>
                <Input value="每次运行随机生成" disabled />
            </label>
        );
    return (
        <label>
            <span title={`${field.nodeId}.${field.fieldName}`}>
                {label}
                <small>
                    {field.nodeId}.{field.fieldName}
                </small>
            </span>
            {Array.isArray(field.options) && field.options.length ? (
                <Select showSearch value={value} options={field.options.map((option) => ({ label: String(option), value: option }))} onChange={onChange} />
            ) : type === "BOOLEAN" || typeof value === "boolean" ? (
                <Switch checked={value === true || value === "true"} onChange={onChange} />
            ) : type === "NUMBER" || typeof value === "number" ? (
                <InputNumber className="w-full" value={numberValue(value)} min={numberValue(field.min)} max={numberValue(field.max)} step={numberValue(field.step)} onChange={onChange} />
            ) : (
                <Input value={displayValue(value)} onChange={(event) => onChange(event.target.value)} />
            )}
        </label>
    );
}

function ResultPreview({ capability, urls, video }: { capability: RunningHubCapability; urls: string[]; video?: BackendGenerationResult["video"] }) {
    if (capability === "video") return <VideoResultPreview storageKey={video?.storageKey || ""} fallback={video?.dataUrl || video?.url || urls[0]} />;
    if (capability === "audio") return <GenerationAudioOutput output={{ id: "preview", outputIndex: 0, mediaType: "audio", dataUrl: urls[0] }} />;
    return (
        <div className="workflow-test-image-results">
            {urls.map((url) => (
                <CachedResourceImage key={url} src={url} alt="工作流测试输出" />
            ))}
        </div>
    );
}

function VideoResultPreview({ storageKey, fallback }: { storageKey: string; fallback: string }) {
    const playback = useResourceVideoPlayback(storageKey, fallback);
    if (playback.error) return (
        <div>
            <EmptyState size="compact" title={playback.error} />
            <Button onClick={playback.retry}>重新加载视频</Button>
        </div>
    );
    if (playback.loading || !playback.url) return <EmptyState size="compact" title="正在加载视频" />;
    return (
        <video
            src={playback.url}
            controls
            playsInline
            preload="auto"
            aria-label="工作流测试视频输出"
            onError={() => { if (!playback.requestCompatible()) playback.fail(); }}
        />
    );
}

// 测试参数只写入本次任务配置副本，正式工作流仍由设置页的显式保存动作维护。
function buildTestConfig(config: AiConfig, provider: WorkflowProvider, workflowId: string, workflowKind: "workflow" | "app", fields: WorkflowFieldMapping[], values: Record<string, unknown>): AiConfig {
    const patchedFields = fields.map((field) => {
        const value = values[testFieldKey(field)];
        return value === undefined ? { ...field } : { ...field, fieldValue: value };
    });
    const next: AiConfig = { ...config, taskWorkflowProvider: provider };
    applySourceValues(next, fields, values);
    if (provider === "runninghub") {
        next.runningHub = {
            ...config.runningHub,
            enabled: true,
            workflowId,
            selectedKind: workflowKind,
            workflows: config.runningHub.workflows.map((item) => (item.workflowId.trim() === workflowId.trim() && (item.kind === "app" ? "app" : "workflow") === workflowKind ? { ...item, fields: patchedFields } : item)),
        };
    }
    return next;
}

function applySourceValues(config: AiConfig, fields: WorkflowFieldMapping[], values: Record<string, unknown>) {
    const assigned = new Set<string>();
    fields.forEach((field) => {
        const source = String(field.source || "");
        if (!source || assigned.has(source) || isPromptOrMediaSource(source)) return;
        assigned.add(source);
        const value = values[testFieldKey(field)];
        if (source === "size" || source === "aspectRatio") config.size = String(value || config.size);
        else if (source === "width" || source === "height") {
            const width = String(values[sourceValueKey(fields, "width")] || dimensionFromSize(config.size, 0));
            const height = String(values[sourceValueKey(fields, "height")] || dimensionFromSize(config.size, 1));
            if (width && height) config.size = `${width}x${height}`;
        } else if (source in config && typeof config[source as keyof AiConfig] === "string") {
            (config as unknown as Record<string, unknown>)[source] = String(value ?? "");
        }
    });
}

function initialFieldValues(fields: WorkflowFieldMapping[], config: AiConfig) {
    const values: Record<string, unknown> = {};
    const promptKeys = new Set(workflowPromptTargets(fields).map(testFieldKey));
    fields.forEach((field) => {
        if (promptKeys.has(testFieldKey(field)) || isPromptOrMediaSource(String(field.source || ""))) return;
        const source = String(field.source || "");
        const workflowValue = field.fieldValue ?? field.value ?? field.defaultValue ?? field.default;
        const configValue = source === "aspectRatio" ? config.size : source === "width" ? dimensionFromSize(config.size, 0) : source === "height" ? dimensionFromSize(config.size, 1) : (config as unknown as Record<string, unknown>)[source];
        values[testFieldKey(field)] = workflowValue !== undefined && workflowValue !== "" ? workflowValue : configValue !== undefined && configValue !== "" ? configValue : "";
    });
    return values;
}

function uniqueParameterFields(fields: WorkflowFieldMapping[]) {
    const keys = new Set<string>();
    const promptKeys = new Set(workflowPromptTargets(fields).map(testFieldKey));
    return fields.filter((field) => {
        const source = String(field.source || "");
        if (promptKeys.has(testFieldKey(field)) || isPromptOrMediaSource(source)) return false;
        const key = testFieldKey(field);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
    });
}

function testFieldKey(field: WorkflowFieldMapping) {
    const source = String(field.source || "");
    return source ? `source:${source}` : `field:${field.nodeId}:${field.fieldName}`;
}

function sourceValueKey(fields: WorkflowFieldMapping[], source: string) {
    const field = fields.find((item) => item.source === source);
    return field ? testFieldKey(field) : `source:${source}`;
}

function mediaSlotCounts(fields: WorkflowFieldMapping[]) {
    const result: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
    const imageReferences = referenceImageSlotCount(fields);
    const hasMask = fields.some((field) => field.source === "mask");
    result.image = imageReferences + (hasMask ? 1 : 0);
    fields.forEach((field) => {
        const source = String(field.source || "");
        if (source === "referenceVideo") result.video = Math.max(result.video, Number(field.sourceIndex) + 1 || 1);
        if (source === "referenceAudio") result.audio = Math.max(result.audio, Number(field.sourceIndex) + 1 || 1);
    });
    return result;
}

function missingRequiredInput(fields: WorkflowFieldMapping[], files: Record<MediaKind, TestFile[]>, values: Record<string, unknown>) {
    const imageReferences = referenceImageSlotCount(fields);
    for (const field of fields) {
        if (!field.required) continue;
        const source = String(field.source || "");
        if (workflowPromptTargets([field]).length) continue;
        const kind = source === "referenceImage" || source === "mask" ? "image" : source === "referenceVideo" ? "video" : source === "referenceAudio" ? "audio" : null;
        const index = source === "mask" ? imageReferences : source === "referenceImage" ? Math.max(0, (Number(field.imageOrder) || 1) - 1) : Math.max(0, Number(field.sourceIndex) || 0);
        if (kind && !files[kind][index]) return `请上传第 ${index + 1} 个${mediaName(kind)}素材`;
        if (!source && !field.randomEnabled && isEmptyTestValue(values[testFieldKey(field)])) return `请填写动态参数：${field.label || field.fieldName}`;
    }
    return "";
}

function referenceImageSlotCount(fields: WorkflowFieldMapping[]) {
    return fields.reduce((count, field) => (field.source === "referenceImage" ? Math.max(count, Number(field.imageOrder) || Number(field.sourceIndex) + 1 || 1) : count), 0);
}

function isPromptOrMediaSource(source: string) {
    return ["prompt", "referenceImage", "referenceVideo", "referenceAudio", "mask"].includes(source);
}

function generationResultUrls(result: BackendGenerationResult | null, capability: RunningHubCapability) {
    if (capability === "text") return [];
    const media = capability === "image" ? result?.images || [] : capability === "video" ? (result?.video ? [result.video] : []) : result?.audio ? [result.audio] : [];
    return media
        .map((item) => {
            const resourceId = resourceIdFromStorageKey(item.storageKey);
            return resourceId ? resourceFileUrl(resourceId) : item.dataUrl || item.url || "";
        })
        .filter(Boolean);
}

function toReferenceImage(item: TestFile): ReferenceImage {
    return { id: item.id, name: item.file.name, type: item.file.type, dataUrl: item.url, bytes: item.file.size };
}
function toReferenceVideo(item: TestFile): ReferenceVideo {
    return { id: item.id, name: item.file.name, type: item.file.type, url: item.url, bytes: item.file.size };
}
function toReferenceAudio(item: TestFile): ReferenceAudio {
    return { id: item.id, name: item.file.name, type: item.file.type, url: item.url, bytes: item.file.size };
}
function dimensionFromSize(size: string, index: number) {
    const normalized = size.toLowerCase().trim();
    const pixels = normalized.split("x");
    if (pixels.length === 2 && pixels.every((item) => Number(item.trim()) > 0)) return pixels[index]?.trim() || "";
    const ratio = normalized
        .replace(/-(1k|2k|4k)$/, "")
        .split(":")
        .map(Number);
    if (ratio.length !== 2 || ratio.some((item) => !Number.isFinite(item) || item <= 0)) return "";
    const longEdgeTier = normalized.endsWith("-4k") ? 3840 : normalized.endsWith("-2k") ? 2048 : 0;
    const dimensions =
        longEdgeTier > 0
            ? ratio[0] >= ratio[1]
                ? [longEdgeTier, Math.round((longEdgeTier * ratio[1]) / ratio[0])]
                : [Math.round((longEdgeTier * ratio[0]) / ratio[1]), longEdgeTier]
            : ratio[0] >= ratio[1]
              ? [Math.round((1024 * ratio[0]) / ratio[1]), 1024]
              : [1024, Math.round((1024 * ratio[1]) / ratio[0])];
    return String(dimensions[index]);
}
function isEmptyTestValue(value: unknown) {
    return value === undefined || value === null || (typeof value === "string" && !value.trim());
}
function numberValue(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function displayValue(value: unknown) {
    return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
}
function capabilityName(value: RunningHubCapability) {
    return value === "text" ? "文字" : value === "video" ? "视频" : value === "audio" ? "音频" : "图片";
}
function mediaName(value: MediaKind) {
    return value === "video" ? "视频" : value === "audio" ? "音频" : "图片";
}
function mediaIcon(value: MediaKind) {
    return value === "video" ? <Film /> : value === "audio" ? <FileAudio /> : <FileImage />;
}
function taskStageLabel(status: string, stage?: string) {
    if (status === "queued") return "任务已排队";
    if (status === "succeeded") return "正在读取结果";
    if (status === "failed") return "任务失败";
    return stage ? `运行中 · ${stage}` : "工作流运行中";
}
