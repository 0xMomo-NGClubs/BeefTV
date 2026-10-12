import { useState } from "react";
import { App, Button } from "antd";
import { RefreshCw } from "lucide-react";
import { useCanvasNodeActions } from "./canvas-node-action-context";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasGenerationTaskRefresh({ node }: { node: CanvasNodeData }) {
    const { refreshTaskResult } = useCanvasNodeActions();
    const { message } = App.useApp();
    const [loading, setLoading] = useState(false);
    if (!refreshTaskResult || !node.metadata?.taskId || (node.metadata.taskProvider !== "runninghub" && node.metadata.workflowProvider !== "runninghub")) return null;
    return <Button size="small" icon={<RefreshCw className="size-3" />} loading={loading} className="absolute bottom-2 left-2 z-[var(--node-z-overlay)]" data-canvas-no-zoom title="查询原任务结果，不重新生成" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
        event.stopPropagation();
        if (loading) return;
        setLoading(true);
        void refreshTaskResult(node).catch((error) => message.error(error instanceof Error ? error.message : "刷新结果失败")).finally(() => setLoading(false));
    }}>刷新结果</Button>;
}
