import { App, AutoComplete, Button, Form, Input, Popconfirm } from "antd";
import { Switch } from "@/components/ui/base/switch";
import { Select } from "@/components/ui/base/select";
import { SegmentedControl } from "@/components/ui/base/segmented-control";
import { RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { WorkflowFieldMappingEditor } from "@/components/workflow-field-mapping-editor";
import { WorkflowVideoControlsEditor } from "@/components/workflow-video-controls-editor";
import { WorkflowPromptMappingEditor } from "@/components/workflow-prompt-mapping-editor";
import { WorkflowGraphEditor } from "@/components/workflow-graph-editor";
import { WorkflowTestWorkbench } from "@/components/workflow-test-workbench";
import { fetchRunningHubApp, fetchRunningHubWorkflow } from "@/services/api/runninghub";
import { fetchPluginRuntimeState, setUserPluginEnabled } from "@/services/api/plugins";
import { RUNNINGHUB_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { usePluginStore } from "@/stores/use-plugin-store";
import { flushModelConfig, getModelConfigPersistenceState, subscribeModelConfigPersistence } from "@/services/model-config-repository";
import { observeRunningHubMetadataRequest } from "./runninghub-metadata-request";
import { defaultWorkflowTextOutputNodeId, workflowTextOutputOptions } from "@/lib/workflow-text-outputs";
import { workflowMediaInputPolicy } from "@/lib/workflow-image-inputs";
import {
    normalizeRunningHubCapability,
    normalizeRunningHubWorkflowKind,
    mergeWorkflowFieldMappings,
    normalizeWorkflowFieldMappings,
    useConfigStore,
    type RunningHubCapability,
    type RunningHubConfig,
    type RunningHubWorkflow,
    type RunningHubWorkflowKind,
    type WorkflowFieldMapping,
} from "@/stores/use-config-store";

const capabilityOptions = [
    { label: "文字", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

function workflowCapability(workflow: RunningHubWorkflow | undefined, fallback: RunningHubCapability): RunningHubCapability {
    return normalizeRunningHubCapability(workflow?.capability, normalizeRunningHubCapability(fallback));
}

function workflowKind(workflow: RunningHubWorkflow | undefined): RunningHubWorkflowKind {
    return normalizeRunningHubWorkflowKind(workflow?.kind);
}

function workflowEntryKey(workflow: RunningHubWorkflow): string {
    return `${workflowKind(workflow)}:${workflow.workflowId.trim()}`;
}

function capabilityLabel(capability: RunningHubCapability) {
    return capability === "text" ? "文字" : capability === "video" ? "视频" : capability === "audio" ? "音频" : "图片";
}

export function RunningHubSettingsPane() {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const runningHub = config.runningHub;
    const pluginState = usePluginStore((state) => state.pluginStates[RUNNINGHUB_PLUGIN_ID]);
    const persistence = useSyncExternalStore(subscribeModelConfigPersistence, getModelConfigPersistenceState, getModelConfigPersistenceState);
    const [activating, setActivating] = useState(false);
    const [loadingPlugin, setLoadingPlugin] = useState(true);
    const [pluginError, setPluginError] = useState("");
    const selected = runningHub.workflows.find((item) => item.workflowId.trim() === runningHub.workflowId.trim() && workflowKind(item) === runningHub.selectedKind);
    const selectedKey = selected ? workflowEntryKey(selected) : undefined;
    const inputPolicyErrors = (selected?.fields || []).flatMap((field) => {
        const policy = workflowMediaInputPolicy(selected, field);
        return policy.error ? [`${field.nodeId}.${field.fieldName}：${policy.error}`] : [];
    });
    const [draftId, setDraftId] = useState(selected?.workflowId || "");
    const [workflowText, setWorkflowText] = useState(selected?.workflowJson ? JSON.stringify(selected.workflowJson, null, 2) : "");
    const [kind, setKind] = useState<RunningHubWorkflowKind>(selected ? workflowKind(selected) : runningHub.selectedKind);
    const [title, setTitle] = useState(selected?.title || "");
    const [capability, setCapability] = useState<RunningHubCapability>(workflowCapability(selected, runningHub.capability));
    const [fetching, setFetching] = useState(false);
    const fetchController = useRef<AbortController | null>(null);
    const [workspaceMode, setWorkspaceMode] = useState<"fields" | "test">("fields");

    useEffect(() => () => {
        const controller = fetchController.current;
        fetchController.current = null;
        controller?.abort();
    }, []);

    useEffect(() => {
        let cancelled = false;
        void fetchPluginRuntimeState().then((runtime) => {
            if (cancelled) return;
            usePluginStore.getState().setPluginStates(runtime.states);
            usePluginStore.getState().setRuntimeStatuses(runtime.statuses);
        }).catch((error) => {
            if (!cancelled) setPluginError(error instanceof Error ? error.message : "读取 RunningHub 插件状态失败");
        }).finally(() => {
            if (!cancelled) setLoadingPlugin(false);
        });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!selected) return;
        setDraftId(selected.workflowId);
        setWorkflowText(selected.workflowJson ? JSON.stringify(selected.workflowJson, null, 2) : "");
        setKind(workflowKind(selected));
        setTitle(selected.title || "");
        setCapability(workflowCapability(selected, runningHub.capability));
    }, [selectedKey, selected?.workflowJson, selected?.title, selected?.capability, runningHub.capability]);

    const update = (patch: Partial<RunningHubConfig>) => updateConfig("runningHub", { ...useConfigStore.getState().config.runningHub, ...patch });
    const draftMatchesSelected = Boolean(selected && workflowEntryKey(selected) === `${kind}:${draftId.trim()}`);

    const toggleEnabled = async (enabled: boolean) => {
        if (!enabled) fetchController.current?.abort();
        setActivating(true);
        try {
            const next = await setUserPluginEnabled(RUNNINGHUB_PLUGIN_ID, enabled);
            const store = usePluginStore.getState();
            store.setPluginStates({ ...store.pluginStates, [next.pluginId]: next });
            store.setRuntimeStatuses({ ...store.runtimeStatuses, [next.pluginId]: next.effectiveEnabled ? "enabled" : "disabled" });
            update({ enabled });
            await flushModelConfig();
            const saved = getModelConfigPersistenceState();
            if (saved.status === "error" || saved.dirty) throw new Error(saved.error || "RunningHub 配置尚未保存，请重试");
            setPluginError("");
            message.success(enabled ? "RunningHub 已启用" : "RunningHub 已停用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新 RunningHub 状态失败");
        } finally {
            setActivating(false);
        }
    };

    const persistWorkflow = (workflow: RunningHubWorkflow, nextCapability = capability) => {
        const workflowId = workflow.workflowId.trim();
        if (!workflowId) return;
        const nextKind = workflowKind(workflow);
        const next: RunningHubWorkflow = {
            ...workflow,
            kind: nextKind,
            workflowId,
            capability: normalizeRunningHubCapability(nextCapability, capability),
            fields: normalizeWorkflowFieldMappings(workflow.fields, normalizeRunningHubCapability(nextCapability, capability)),
        };
        delete next.raw;
        if (nextKind === "app") {
            // AI 应用只保存其公开参数，绝不能继续携带之前 Workflow 的 JSON。
            delete next.workflowJson;
            next.webappId = (next.webappId || workflowId).trim();
        } else {
            delete next.webappId;
        }
        const nextKey = workflowEntryKey(next);
        update({
            workflowId,
            selectedKind: nextKind,
            capability: next.capability || capability,
            workflows: [...useConfigStore.getState().config.runningHub.workflows.filter((item) => workflowEntryKey(item) !== nextKey), next],
        });
    };

    const fetchWorkflow = async () => {
        if (!runningHub.enabled || !pluginState?.effectiveEnabled) return message.warning("请先启用 RunningHub");
        const id = draftId.trim();
        if (!id) return message.warning(kind === "app" ? "请先填写 webappId" : "请先填写 workflowId");
        if (!runningHub.apiKey.trim()) return message.warning("请先填写消费级 API Key");
        fetchController.current?.abort();
        const controller = new AbortController();
        fetchController.current = controller;
        const request = observeRunningHubMetadataRequest(controller);
        controller.signal.addEventListener("abort", () => {
            if (fetchController.current === controller) {
                fetchController.current = null;
                setFetching(false);
            }
        }, { once: true });
        setFetching(true);
        try {
            if (!request.isCurrent()) return;
            // 管理接口只接受拉取参数所需的小请求，不能把已保存工作流及大段 JSON 一并提交。
            const fetchConfig = {
                baseUrl: request.connection.baseUrl,
                apiKey: request.connection.apiKey,
                walletApiKey: "",
                useWallet: false,
                title: title.trim(),
                capability,
            };
            const result = kind === "app" ? await fetchRunningHubApp({ ...fetchConfig, webappId: id }, controller.signal, request.expectedScope) : await fetchRunningHubWorkflow({ ...fetchConfig, workflowId: id }, controller.signal, request.expectedScope);
            if (!request.isCurrent()) return;
            const existing = useConfigStore.getState().config.runningHub.workflows.find((workflow) => workflowEntryKey(workflow) === `${kind}:${id}`);
            const item: RunningHubWorkflow = {
                ...result,
                kind,
                workflowId: id,
                webappId: kind === "app" ? result.webappId || id : undefined,
                title: result.title || title.trim() || id,
                fields: existing ? mergeWorkflowFieldMappings(existing.fields, result.fields, capability) : normalizeWorkflowFieldMappings(result.fields, capability),
                videoControls: existing?.videoControls,
                optionalImageMode: existing?.optionalImageMode,
                primaryTextOutputNodeId: existing?.primaryTextOutputNodeId ?? (capability === "text" ? defaultWorkflowTextOutputNodeId(result.workflowJson) : undefined),
                workflowJson: kind === "workflow" ? result.workflowJson || {} : undefined,
            };
            persistWorkflow(item, capability);
            setWorkflowText(item.workflowJson ? JSON.stringify(item.workflowJson, null, 2) : "");
            setTitle(item.title || "");
            await flushModelConfig();
            if (!request.isCurrent()) return;
            const saved = getModelConfigPersistenceState();
            if (saved.status === "error" || saved.dirty) throw new Error(saved.error || "参数尚未保存到本地后端，请重试");
            message.success(
                `${kind === "app" ? "RunningHub App" : "RunningHub 工作流"}参数已重新拉取并保存`,
            );
        } catch (error) {
            if (!request.isCurrent()) return;
            message.error(error instanceof Error ? `拉取失败：${error.message}` : "拉取 RunningHub 参数失败");
        } finally {
            request.dispose();
            if (fetchController.current === controller) {
                fetchController.current = null;
                setFetching(false);
            }
        }
    };

    const removeWorkflow = async (workflow: RunningHubWorkflow) => {
        fetchController.current?.abort();
        const targetKey = workflowEntryKey(workflow);
        const remaining = runningHub.workflows.filter((item) => workflowEntryKey(item) !== targetKey);
        update({ workflowId: "", selectedKind: workflowKind(workflow), workflows: remaining });
        setDraftId("");
        setWorkflowText("");
        setTitle("");
        await flushModelConfig();
        const saved = getModelConfigPersistenceState();
        if (saved.status === "error" || saved.dirty) {
            const error = new Error(saved.error || "删除尚未保存，请重试");
            message.error(error.message);
            throw error;
        }
        message.success(`已删除${workflowKind(workflow) === "app" ? " App" : " Workflow"}：${workflow.title || workflow.workflowId}`);
    };

    const updateCapability = (value: RunningHubCapability) => {
        const nextCapability = normalizeRunningHubCapability(value, capability);
        setCapability(nextCapability);
        if (selected && draftMatchesSelected) persistWorkflow({ ...selected, capability: nextCapability }, nextCapability);
    };

    const selectWorkflow = (entryKey: string | undefined) => {
        fetchController.current?.abort();
        if (!entryKey) {
            update({ workflowId: "" });
            setDraftId("");
            setWorkflowText("");
            setTitle("");
            return;
        }
        const workflow = runningHub.workflows.find((item) => workflowEntryKey(item) === entryKey);
        if (!workflow) return message.error("已保存条目不存在，请刷新页面后重试");
        const nextCapability = workflowCapability(workflow, runningHub.capability);
        update({ workflowId: workflow.workflowId.trim(), selectedKind: workflowKind(workflow), capability: nextCapability });
        setDraftId(workflow.workflowId.trim());
        setWorkflowText(workflow.workflowJson ? JSON.stringify(workflow.workflowJson, null, 2) : "");
        setKind(workflowKind(workflow));
        setTitle(workflow.title || "");
        setCapability(nextCapability);
    };

    const changeKind = (nextKind: RunningHubWorkflowKind) => {
        fetchController.current?.abort();
        setKind(nextKind);
        setDraftId("");
        setWorkflowText("");
        setTitle("");
        update({ workflowId: "", selectedKind: nextKind });
    };

    const updateWorkflowJson = (value: string) => {
        if (kind === "app") return;
        if (!selected || !draftMatchesSelected) return message.warning("请先拉取或选择要编辑的 Workflow");
        try {
            const parsed = value.trim() ? JSON.parse(value) : {};
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工作流 JSON 必须是对象");
            persistWorkflow({ ...selected, title: title.trim() || selected.title, workflowJson: parsed });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "工作流 JSON 格式无效");
        }
    };

    const updateWorkflowFields = (fields: WorkflowFieldMapping[]) => {
        if (!selected || !draftMatchesSelected) return;
        persistWorkflow({ ...selected, title: title.trim() || selected.title, fields });
    };

    const updateTitle = () => {
        if (!selected || !draftMatchesSelected) return;
        persistWorkflow({ ...selected, title: title.trim() || selected.workflowId });
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>RunningHub 工作流</h2>
                    <p>素材上传、工作流提交和结果查询共用消费级 API Key。</p>
                </div>
                <Switch aria-label="启用 RunningHub" checked={runningHub.enabled && Boolean(pluginState?.effectiveEnabled)} loading={activating || loadingPlugin} disabled={loadingPlugin || !pluginState?.canToggle} checkedChildren="启用" unCheckedChildren="停用" onChange={(enabled) => void toggleEnabled(enabled)} />
            </div>
            {pluginError || pluginState?.blockedReason ? <p role="alert" className="mb-3 text-sm text-foreground/65">{pluginError || pluginState?.blockedReason}</p> : null}
            <p role="status" className="mb-3 text-xs text-foreground/55">
                {persistence.status === "error" ? `配置尚未保存到本地后端：${persistence.error}` : persistence.dirty ? "正在保存到本地后端…" : "配置由本地后端保存，密钥不写入浏览器持久缓存。"}
            </p>
            <div className="settings-section grid gap-3 lg:grid-cols-12">
                <Form.Item label="Base URL" className="mb-0 lg:col-span-6">
                    <AutoComplete
                        className="w-full"
                        value={runningHub.baseUrl}
                        options={[
                            { label: "中国站 · https://www.runninghub.cn", value: "https://www.runninghub.cn" },
                            { label: "国际站 · https://www.runninghub.ai", value: "https://www.runninghub.ai" },
                        ]}
                        onChange={(baseUrl) => update({ baseUrl })}
                        onBlur={() => update({ baseUrl: runningHub.baseUrl.trim().replace(/\/+$/, "") })}
                    >
                        <Input placeholder="选择官方站点或填写兼容网关地址" />
                    </AutoComplete>
                </Form.Item>
                <Form.Item label="消费级 API Key" className="mb-0 lg:col-span-6" extra="填写官方「消费级-会员」API Key，用于拉取参数、上传素材、运行工作流和查询结果。请确认会员权益有效，并与所选站点一致。">
                    <Input.Password autoComplete="new-password" value={runningHub.apiKey} onChange={(event) => update({ apiKey: event.target.value })} />
                </Form.Item>
                <Form.Item label="工作流用途" className="mb-0 lg:col-span-6">
                    <Select className="w-full" value={capability} options={capabilityOptions} onChange={(value) => updateCapability(value as RunningHubCapability)} />
                </Form.Item>
                <Form.Item label="已保存条目" className="mb-0 lg:col-span-6">
                    <Select
                        className="w-full"
                        allowClear
                        value={selectedKey}
                        options={runningHub.workflows.map((item) => ({
                            label: `${workflowKind(item) === "app" ? "App" : "Workflow"} · ${item.title || item.workflowId} · ${capabilityLabel(workflowCapability(item, runningHub.capability))}`,
                            value: workflowEntryKey(item),
                        }))}
                        placeholder="选择已保存 Workflow / App"
                        onChange={selectWorkflow}
                    />
                </Form.Item>
                <Form.Item label="类型" className="mb-0 lg:col-span-3">
                    <SegmentedControl
                        block
                        value={kind}
                        options={[
                            { label: "Workflow", value: "workflow" },
                            { label: "App", value: "app" },
                        ]}
                        onChange={(value) => changeKind(value as RunningHubWorkflowKind)}
                    />
                </Form.Item>
                <Form.Item label={kind === "app" ? "webappId" : "workflowId"} className="mb-0 lg:col-span-3">
                    <Input value={draftId} placeholder={kind === "app" ? "RunningHub webappId" : "RunningHub workflowId"} onChange={(event) => { fetchController.current?.abort(); setDraftId(event.target.value); }} />
                </Form.Item>
                <Form.Item label="显示名称" className="mb-0 lg:col-span-6">
                    <Input value={title} placeholder="可选" onChange={(event) => setTitle(event.target.value)} onBlur={updateTitle} />
                </Form.Item>
                <Form.Item label="操作" className="workflow-entry-actions-field mb-0 lg:col-span-6">
                    <div className="workflow-entry-actions">
                        <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={!runningHub.enabled || !pluginState?.effectiveEnabled || activating || loadingPlugin} loading={fetching} onClick={() => void fetchWorkflow()}>
                            拉取参数
                        </Button>
                        <Popconfirm
                            title="删除当前条目？"
                            description={selected ? `${workflowKind(selected) === "app" ? "App" : "Workflow"} · ${selected.title || selected.workflowId}` : undefined}
                            okText="删除"
                            cancelText="取消"
                            onConfirm={() => selected && removeWorkflow(selected)}
                        >
                            <Button danger icon={<Trash2 className="size-4" />} disabled={!selected}>
                                删除
                            </Button>
                        </Popconfirm>
                    </div>
                </Form.Item>
                <div className="workflow-workspace-tabs lg:col-span-12">
                    <SegmentedControl
                        block
                        value={workspaceMode}
                        options={[
                            { label: "字段配置", value: "fields" },
                            { label: "测试画布", value: "test" },
                        ]}
                        onChange={(value) => setWorkspaceMode(value as "fields" | "test")}
                    />
                </div>
                {workspaceMode === "fields" ? <div className="lg:col-span-12"><WorkflowPromptMappingEditor fields={selected?.fields || []} disabled={!selected || !draftMatchesSelected} onChange={updateWorkflowFields} /></div> : null}
                {workspaceMode === "fields" && kind === "workflow" ? <Form.Item label="未提供的参考图片" className="mb-0 lg:col-span-12">
                    <Select aria-label="未提供的参考图片策略" className="w-full" value={selected?.optionalImageMode || "disconnect"} disabled={!selected || !draftMatchesSelected} options={[
                        { label: "断开动态参考槽位（推荐）", value: "disconnect" },
                        { label: "保留工作流默认图片", value: "retain" },
                    ]} onChange={(value) => selected && persistWorkflow({ ...selected, optionalImageMode: value as "disconnect" | "retain" })} />
                    <p className="mt-2 text-xs text-muted-foreground">这是图片槽位的默认策略，识别 LoadImage 直接或经标准缩放、裁剪链连接的动态 reference_images 端口。可在每个素材字段中选择保留默认素材或断开指定最终输入；合并和未适配节点不自动穿过，视频、音频默认保留。关闭映射及必填槽位不自动断开，云端模板不会被改写。</p>
                </Form.Item> : null}
                {workspaceMode === "fields" && capability === "video" ? <div className="lg:col-span-12"><WorkflowVideoControlsEditor fields={selected?.fields || []} value={selected?.videoControls} disabled={!selected || !draftMatchesSelected} onChange={(videoControls) => selected && persistWorkflow({ ...selected, videoControls })} /></div> : null}
                {workspaceMode === "fields" && capability === "text" ? <Form.Item label="主文字输出节点" className="mb-0 lg:col-span-12">
                    <AutoComplete className="w-full" disabled={!selected || !draftMatchesSelected} options={workflowTextOutputOptions(selected?.workflowJson)} value={selected?.primaryTextOutputNodeId || ""} placeholder="自动使用唯一文字输出；多输出时请选择节点" allowClear onChange={(value) => selected && persistWorkflow({ ...selected, primaryTextOutputNodeId: value.trim() })} />
                    <p className="mt-2 text-xs text-muted-foreground">只将所选节点的文字用于下游，其他输出保留在结果列表。App 可填写输出节点 ID。</p>
                    {kind === "workflow" && selected?.primaryTextOutputNodeId && selected.workflowJson && !selected.workflowJson[selected.primaryTextOutputNodeId] ? <p className="mt-1 text-xs text-destructive">已配置的输出节点不在当前工作流中，请重新选择。</p> : null}
                </Form.Item> : null}
                {workspaceMode === "fields" && kind === "workflow" ? (
                    <>
                        {inputPolicyErrors.length ? <div role="alert" className="space-y-1 text-xs text-destructive lg:col-span-12"><p>素材映射需要确认。请在对应字段的“没有素材时”配置中重新选择目标，或改为保留默认素材。</p>{inputPolicyErrors.map((error) => <p key={error}>{error}</p>)}</div> : null}
                        <div className="lg:col-span-12">
                            <WorkflowGraphEditor workflowJson={selected?.workflowJson} optionalImageMode={selected?.optionalImageMode} fields={selected?.fields || []} disabled={!selected || !draftMatchesSelected} onChange={updateWorkflowFields} emptyDescription="请先拉取 RunningHub Workflow" />
                        </div>
                        <details className="workflow-json-details lg:col-span-12">
                            <summary>查看或编辑 ComfyUI API JSON</summary>
                            <Form.Item className="mb-0 mt-3" extra="RunningHub Workflow 与 ComfyUI 共用同一种拓扑解析合同；修改 JSON 后移出输入框即保存。">
                                <Input.TextArea
                                    rows={12}
                                    value={workflowText}
                                    spellCheck={false}
                                    placeholder={'{"3":{"class_type":"...","inputs":{}}}'}
                                    onChange={(event) => setWorkflowText(event.target.value)}
                                    onBlur={() => updateWorkflowJson(workflowText)}
                                />
                            </Form.Item>
                        </details>
                    </>
                ) : null}
                {workspaceMode === "fields" && kind === "app" ? (
                    <Form.Item label="App 公开参数映射" className="mb-0 lg:col-span-12" extra="AI 应用不返回完整 ComfyUI 拓扑，只能编辑当前发布版本的公开参数；应用更新后请再次点击“拉取参数”。">
                        <WorkflowFieldMappingEditor fields={selected?.fields || []} disabled={!selected || !draftMatchesSelected} onChange={updateWorkflowFields} />
                    </Form.Item>
                ) : null}
                {workspaceMode === "test" ? (
                    <div className="lg:col-span-12">
                        <WorkflowTestWorkbench
                            key={`runninghub:${selectedKey || "empty"}`}
                            provider="runninghub"
                            workflowId={selected?.workflowId || ""}
                            workflowKind={selected ? workflowKind(selected) : kind}
                            title={selected?.title || title || draftId}
                            capability={selected ? workflowCapability(selected, capability) : capability}
                            fields={selected?.fields || []}
                            disabled={!runningHub.enabled || !pluginState?.effectiveEnabled || !selected || !draftMatchesSelected || !runningHub.baseUrl.trim() || !runningHub.apiKey.trim()}
                            disabledReason={!runningHub.enabled || !pluginState?.effectiveEnabled ? "请先启用 RunningHub" : !selected || !draftMatchesSelected ? "请先拉取或选择一个已保存的 RunningHub 条目" : !runningHub.baseUrl.trim() ? "请先填写 RunningHub Base URL" : "请先填写消费级 API Key"}
                        />
                    </div>
                ) : null}
            </div>
        </Form>
    );
}

export function runningHubWorkflow(config: RunningHubConfig): RunningHubWorkflow | undefined {
    const workflowId = config.workflowId.trim();
    return config.workflows.find((item) => item.workflowId.trim() === workflowId && workflowKind(item) === config.selectedKind);
}
