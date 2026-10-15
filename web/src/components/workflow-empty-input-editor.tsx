import { Button, Select } from "antd";
import type { WorkflowFieldMapping } from "@/stores/use-config-store";
import { workflowInputTargetIdentity, workflowInputTargetOptions, workflowInputTargetLabel, workflowMediaInputKind, workflowMediaInputPolicy, workflowRecommendedInputTargets } from "@/lib/workflow-image-inputs";

export function WorkflowEmptyInputEditor({ field, workflowJson, optionalImageMode, disabled, onChange }: {
    field: WorkflowFieldMapping;
    workflowJson: Record<string, unknown>;
    optionalImageMode?: "disconnect" | "retain";
    disabled: boolean;
    onChange: (patch: Partial<WorkflowFieldMapping>) => void;
}) {
    if (!workflowMediaInputKind(field)) return null;
    const { targets: candidates, blocked: blockedPaths } = workflowInputTargetOptions(workflowJson, field);
    const recommended = workflowRecommendedInputTargets(workflowJson, field);
    const policy = workflowMediaInputPolicy({ workflowId: "", workflowJson, optionalImageMode }, field);
    const selected = field.emptyInputTargets || [];
    const key = workflowInputTargetIdentity;
    const options = candidates.map((target) => ({ label: workflowInputTargetLabel(target, workflowJson), value: key(target) }));
    const stale = selected.filter((target) => !options.some((option) => option.value === key(target)));
    const blocked = disabled || field.required === true;
    return <div className="min-w-0 space-y-2 break-words rounded-lg border border-border p-3 md:col-span-2 lg:col-span-3">
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            没有素材时
            <Select aria-label={`空素材策略 ${field.nodeId}.${field.fieldName}`} value={field.emptyInputMode || "inherit"} disabled={blocked}
                options={[
                    { label: "沿用工作流默认策略", value: "inherit" },
                    { label: "保留默认素材", value: "retain" },
                    { label: "断开指定输入", value: "disconnect" },
                ]} onChange={(emptyInputMode) => onChange({ emptyInputMode, ...(emptyInputMode === "disconnect" && !selected.length ? { emptyInputTargets: recommended } : {}) })} />
        </label>
        <p className="text-xs text-muted-foreground">素材来源：{field.nodeId}.{field.fieldName} · 输出端口 0</p>
        {field.emptyInputMode === "disconnect" ? <>
            <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                要断开的目标输入（可多选）
                <Select mode="multiple" className="min-w-0 w-full max-w-full" maxTagCount="responsive" maxTagTextLength={40} aria-label={`断开目标 ${field.nodeId}.${field.fieldName}`} value={selected.map(key)} disabled={blocked} placeholder="选择允许省略的最终输入"
                    options={[...options, ...stale.map((target) => ({ label: `已失效 · ${workflowInputTargetLabel(target)}`, value: key(target) }))]}
                    optionRender={(option) => <span className="block whitespace-normal break-all text-xs">{option.label}</span>}
                    onChange={(keys: string[]) => onChange({ emptyInputTargets: keys.flatMap((value) => {
                        const target = [...candidates, ...stale].find((item) => key(item) === value);
                        return target ? [target] : [];
                    }) })} />
            </label>
            {selected.map((target) => <p key={key(target)} className="text-xs text-muted-foreground">{workflowInputTargetLabel(target, workflowJson)}</p>)}
            {recommended.length ? <Button size="small" type="text" disabled={blocked} onClick={() => onChange({ emptyInputTargets: recommended })}>使用推荐目标</Button> : null}
            <p className="text-xs text-muted-foreground">只断开所选最终输入，中间节点和其他分支保留。支持直接连接及标准图片缩放、裁剪链；合并、其他连线依赖和未适配节点不自动穿过。请选择上游允许省略的输入，必需输入的错误由工作流返回。</p>
            {blockedPaths.map((reason) => <p key={reason} className="text-xs text-muted-foreground">{reason}</p>)}
        </> : <p className="text-xs text-muted-foreground">{field.required ? "必填槽位缺少素材时仍会阻止提交。" : policy.targets.length ? `空槽位将断开：${policy.targets.map((target) => workflowInputTargetLabel(target, workflowJson)).join("；")}` : "空槽位保留工作流默认素材和连线。"}</p>}
        {policy.error ? <p role="alert" className="text-xs text-destructive">{policy.error}</p> : null}
        {field.emptyInputMode !== "disconnect" && policy.notice ? <p className="text-xs text-muted-foreground">{policy.notice}</p> : null}
    </div>;
}
