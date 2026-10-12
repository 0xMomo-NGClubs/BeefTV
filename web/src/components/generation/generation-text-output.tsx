import { App, Button } from "antd";
import { Copy } from "lucide-react";

export function GenerationTextOutput({ text }: { text: string }) {
    const { message } = App.useApp();
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            message.success("文字已复制");
        } catch {
            message.error("复制失败，请选择文字后复制");
        }
    };
    return <div className="min-w-0 space-y-2" data-canvas-no-zoom data-canvas-wheel-scroll>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</pre>
        <Button size="small" icon={<Copy className="size-3" />} onClick={() => void copy()}>复制文字</Button>
    </div>;
}
