import { Button, Popover } from "antd";
import { Settings2, SlidersHorizontal } from "lucide-react";
import { WorkflowParameterControls } from "./canvas-config-node-panel";
import { workflowFieldKey, workflowFieldRole, workflowParameterFields, workflowVideoFieldsFromJson } from "@/lib/model-capabilities";
import { workflowSlotReference } from "@/lib/canvas/canvas-workflow-inputs";
import { workflowVideoControlFields, workflowVideoControlSummary } from "@/lib/workflow-video-controls";
import { workflowPromptTargetLabel } from "@/lib/workflow-prompt-mapping";
import { WorkflowInputPlan } from "@/components/workflow-input-plan";
import { type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export function CanvasWorkflowControls({ node, config, theme, references, onConfigChange }: {
    node: CanvasNodeData; config: AiConfig; theme: CanvasTheme; references: CanvasResourceReference[];
    onConfigChange: (id: string, patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const selected = config.runningHub.workflows.find((item) => item.workflowId === node.metadata?.runningHubWorkflowId && (item.kind === "app" ? "app" : "workflow") === (node.metadata?.runningHubWorkflowKind || "workflow"));
    const fields = selected?.fields?.length ? selected.fields : workflowVideoFieldsFromJson(selected?.workflowJson);
    const controls = node.type === CanvasNodeType.Video ? workflowVideoControlFields(fields, selected?.videoControls) : [];
    const mappedKeys = new Set(controls.map(workflowFieldKey));
    const remaining = workflowParameterFields(fields).filter((field) => !mappedKeys.has(workflowFieldKey(field)));
    const common = remaining.filter((field) => workflowFieldRole(field) === "business");
    const advanced = remaining.filter((field) => workflowFieldRole(field) !== "business");
    const media = (selected?.fields || []).filter((field) => field.enabled !== false && ["referenceImage", "referenceVideo", "referenceAudio", "mask"].includes(field.source || ""));
    const summary = workflowVideoControlSummary(fields, selected?.videoControls, node.metadata?.workflowParameters || {});
    const promptTarget = workflowPromptTargetLabel(fields);
    const mediaCounts = { image: references.filter((item) => item.kind === "image" || item.kind === "character").length, video: references.filter((item) => item.kind === "video").length, audio: references.filter((item) => item.kind === "audio").length };
    const providedLabels = Object.fromEntries(media.map((field) => [workflowFieldKey(field), workflowSlotReference(field, references)?.title || ""]));
    const surface = { background: theme.node.panel, color: theme.node.text };
    return <div className="flex min-w-0 items-center gap-1" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
        {controls.length ? <Popover trigger="click" placement="topRight" content={<div className="max-h-80 w-80 overflow-y-auto" style={surface} data-canvas-no-zoom data-canvas-wheel-scroll><WorkflowParameterControls fields={controls} node={node} theme={theme} onConfigChange={onConfigChange} /></div>}>
            <Button size="small" type="text" className="canvas-generation-settings-trigger canvas-node-composer-settings-trigger [&_.lucide]:!size-3" style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} aria-label={`高级设置：${summary}`} title={`视频设置 · ${summary}`}><span className="truncate">{summary || "视频设置"}</span></Button>
        </Popover> : null}
        <Popover trigger="click" placement="topRight" content={<div className="max-h-[min(460px,65vh)] w-[min(360px,80vw)] space-y-2 overflow-y-auto text-xs" style={surface} data-canvas-no-zoom data-canvas-wheel-scroll>
            <div className="truncate font-medium">{selected?.title || selected?.workflowId || "请选择工作流"}</div>
            <p className="break-words" style={{ color: theme.node.muted }}>提示词 → {promptTarget || "未映射，保留工作流字段值"}</p>
            {common.length ? <WorkflowParameterControls fields={common} node={node} theme={theme} onConfigChange={onConfigChange} /> : null}
            {advanced.length ? <WorkflowParameterControls fields={advanced} node={node} theme={theme} onConfigChange={onConfigChange} defaultExpanded={false} /> : null}
            {media.length ? <div className="rounded-lg p-2" style={{ background: theme.node.fill }}><WorkflowInputPlan workflow={selected} fields={selected?.fields} counts={mediaCounts} providedLabels={providedLabels} />{media.some((field) => field.source === "mask") ? <p className="mt-2">蒙版：需要单独配置输入</p> : null}</div> : null}
            {!remaining.length && !media.length ? <p style={{ color: theme.node.muted }}>没有额外参数</p> : null}
        </div>}><Button size="small" type="text" icon={<SlidersHorizontal className="size-3" />} style={{ color: theme.node.muted }} aria-label="工作流参数">参数</Button></Popover>
    </div>;
}
