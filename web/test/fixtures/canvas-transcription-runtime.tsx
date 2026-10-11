import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasTranscriptionControls } from "@/components/canvas/canvas-transcription-controls";
import type { SrtEntry } from "@/types/timeline";

function Fixture() {
    const [running, setRunning] = useState(false);
    const [entries, setEntries] = useState<SrtEntry[]>([]);
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(value => !value)}>{open ? "关闭测试窗口" : "重新打开"}</button><output data-testid="running">{String(running)}</output>{open && <CanvasTranscriptionControls projectId="project-fixture" nodeId="audio-fixture" resourceId="resource-fixture" disabled={running} onRunningChange={setRunning} onResult={setEntries} />}<output data-testid="subtitles">{JSON.stringify(entries)}</output></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
