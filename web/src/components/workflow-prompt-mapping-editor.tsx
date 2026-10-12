import { Select } from "antd";
import { Switch } from "@/components/ui/base/switch";
import { workflowFieldKey } from "@/lib/model-capabilities";
import { setWorkflowPromptEnabled, setWorkflowPromptTargets, workflowPromptFieldOptions, workflowPromptTargets } from "@/lib/workflow-prompt-mapping";
import type { WorkflowFieldMapping } from "@/stores/use-config-store";

export function WorkflowPromptMappingEditor({ fields, disabled, onChange }: {
    fields: WorkflowFieldMapping[]; disabled?: boolean; onChange: (fields: WorkflowFieldMapping[]) => void;
}) {
    const targets = workflowPromptTargets(fields, true);
    const enabled = workflowPromptTargets(fields).length > 0;
    return <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="text-sm font-medium">提示词输入映射</div>
        <p className="text-xs text-muted-foreground">节点提示词、连接进来的文字及测试提示词统一提交到所选字段。可选择多个目标；取消或关闭映射后不写入画布提示词。</p>
        <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs">目标字段</span>
            <Select className="min-w-0 flex-1" mode="multiple" showSearch optionFilterProp="label" allowClear aria-label="提示词映射字段" placeholder="选择接收提示词的节点字段" value={targets.map(workflowFieldKey)} options={workflowPromptFieldOptions(fields)} disabled={disabled} onChange={(keys: string[]) => onChange(setWorkflowPromptTargets(fields, keys))} />
            <Switch checked={enabled} disabled={disabled || !targets.length} aria-label="启用提示词映射" onChange={(value) => onChange(setWorkflowPromptEnabled(fields, value))} />
        </div>
        {!enabled ? <p className="text-xs text-muted-foreground">关闭时使用工作流原值；取消目标选择后，可在参数中填写固定值。</p> : null}
    </div>;
}
