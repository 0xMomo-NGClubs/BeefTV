import { workflowFieldKey } from "@/lib/model-capabilities";
import { workflowEmptyMediaLabel, workflowInputTargetLabel, workflowMediaInputPlan, type WorkflowMediaCounts, type WorkflowMediaKind } from "@/lib/workflow-image-inputs";
import type { RunningHubWorkflow, WorkflowFieldMapping } from "@/stores/use-config-store";

export function WorkflowInputPlan({ workflow, counts, fields, kind, providedLabels }: {
    workflow?: RunningHubWorkflow;
    counts: WorkflowMediaCounts;
    fields?: WorkflowFieldMapping[];
    kind?: WorkflowMediaKind;
    providedLabels?: Record<string, string>;
}) {
    const plan = workflowMediaInputPlan(workflow, counts, fields).filter((item) => !kind || item.kind === kind);
    if (!plan.length) return null;
    const provided = kind ? counts[kind] : counts.image + counts.video + counts.audio;
    const disconnected = plan.filter((item) => item.action === "disconnect").length;
    const retained = plan.filter((item) => item.action === "retain").length;
    return <details className="space-y-2 text-xs">
        <summary className="cursor-pointer">本次提供 {provided} 份 · 断开 {disconnected} 槽 · 保留默认 {retained} 槽{plan.some((item) => item.error) ? " · 配置需确认" : ""}</summary>
        <div className="space-y-2">
            {plan.map((item) => <div key={workflowFieldKey(item.field)} className="break-words">
                <p>{item.kind === "image" ? "图片" : item.kind === "video" ? "视频" : "音频"} {item.slotIndex + 1} · {item.field.nodeId}.{item.field.fieldName} → {item.action === "provided" && providedLabels?.[workflowFieldKey(item.field)] || workflowEmptyMediaLabel(item)}</p>
                {item.targets.length ? <p className="mt-1 opacity-70">{item.targets.map((target) => workflowInputTargetLabel(target, workflow?.workflowJson)).join("；")}</p> : null}
                {item.error ? <p role="alert" className="mt-1 text-destructive">请返回工作流字段配置修正后再生成。</p> : null}
            </div>)}
        </div>
    </details>;
}
