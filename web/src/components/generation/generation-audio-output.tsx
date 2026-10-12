import { Button } from "antd";
import { useEffect, useState } from "react";
import { getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import type { GenerationOutput } from "@/lib/generation-outputs";
import { readGenerationOutputBlob } from "@/services/generation-output-media";

export function GenerationAudioOutput({ output }: { output: GenerationOutput }) {
    const [state, setState] = useState({ identity: "", url: "", loading: true, error: "" });
    const [retry, setRetry] = useState(0);
    const [scopeEpoch, setScopeEpoch] = useState(getActiveUserScopeEpoch);
    const identity = JSON.stringify([output.storageKey, output.dataUrl, output.url, scopeEpoch]);
    useEffect(() => subscribeUserScope((epoch) => setScopeEpoch(epoch.generation)), []);
    useEffect(() => {
        const controller = new AbortController();
        let ownedUrl = "";
        setState({ identity, url: "", loading: true, error: "" });
        void readGenerationOutputBlob(output, controller.signal).then((blob) => {
            if (controller.signal.aborted) return;
            ownedUrl = URL.createObjectURL(blob);
            setState({ identity, url: ownedUrl, loading: false, error: "" });
        }).catch((error) => {
            if (!controller.signal.aborted) setState({ identity, url: "", loading: false, error: error instanceof Error ? error.message : "音频读取失败" });
        });
        return () => { controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
    }, [output, identity, retry]);
    const current = state.identity === identity;
    return <div>
        {current && state.url ? <audio controls src={state.url} className="w-full" onError={() => setState((state) => ({ ...state, error: "音频暂时无法播放，请重新读取" }))} /> : null}
        {!current || state.loading ? <p role="status">正在读取音频…</p> : null}
        {current && state.error ? <div role="alert">{state.error}<Button size="small" onClick={() => setRetry((value) => value + 1)}>重新读取</Button></div> : null}
    </div>;
}
