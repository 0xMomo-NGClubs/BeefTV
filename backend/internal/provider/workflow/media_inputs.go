package workflow

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
)

var dynamicReferenceImageInput = regexp.MustCompile(`^reference_images\.reference_image_[0-9]+$`)

func workflowMediaKind(field Field) string {
	source := strings.NewReplacer("_", "", "-", "", " ", "").Replace(normalizeWorkflowFieldSource(field))
	switch source {
	case "referenceimage", "referenceimages", "image":
		return "image"
	case "referencevideo", "referencevideos", "video":
		return "video"
	case "referenceaudio", "referenceaudios", "audio":
		return "audio"
	}
	return ""
}

func workflowInputGraphRequired(config Config) bool {
	if config.OptionalImageMode != "retain" {
		return true
	}
	for _, field := range config.WorkflowFields {
		if field.EmptyInputMode == "disconnect" && (field.Enabled == nil || *field.Enabled) && !field.Required && workflowMediaKind(field) != "" && !isRunningHubUnsafeInternalField(config.WorkflowJSON, field) {
			return true
		}
	}
	return false
}

// Only the selected edges are removed on a copy. Shared loaders, intermediate
// nodes and independent output branches are never deleted or bypassed.
func workflowWithProvidedMedia(graph map[string]interface{}, fields []Field, counts map[string]int, policy string) (map[string]interface{}, bool, error) {
	if policy != "" && policy != "disconnect" && policy != "retain" {
		return nil, false, fmt.Errorf("不支持的参考图片默认策略：%s", policy)
	}
	targets := map[string]InputTarget{}
	owners := map[string]string{}
	activePerNode := map[string]int{}
	for _, field := range fields {
		if field.Enabled != nil && !*field.Enabled || isRunningHubUnsafeInternalField(graph, field) || workflowMediaKind(field) == "" {
			continue
		}
		activePerNode[field.NodeID]++
	}
	for _, field := range fields {
		if field.Required || field.Enabled != nil && !*field.Enabled || isRunningHubUnsafeInternalField(graph, field) {
			continue
		}
		kind := workflowMediaKind(field)
		if kind == "" {
			continue
		}
		var selected []InputTarget
		switch field.EmptyInputMode {
		case "retain":
			continue
		case "", "inherit":
			if policy != "retain" && kind == "image" {
				selected = workflowRecommendedImageTargets(graph, field)
			}
		case "disconnect":
			if len(field.EmptyInputTargets) == 0 {
				return nil, false, fmt.Errorf("工作流字段 %s.%s：请选择空素材时要断开的目标输入", field.NodeID, field.FieldName)
			}
			for _, target := range field.EmptyInputTargets {
				if !workflowInputTargetValid(graph, field, target) {
					return nil, false, fmt.Errorf("工作流字段 %s.%s：目标 %s.%s 已失效，请重新选择", field.NodeID, field.FieldName, target.NodeID, target.InputName)
				}
				key := target.NodeID + "\x00" + target.InputName
				owner := field.NodeID + "\x00" + field.FieldName
				if previous, ok := owners[key]; ok && previous != owner {
					return nil, false, fmt.Errorf("工作流目标 %s.%s 被多个素材字段重复配置", target.NodeID, target.InputName)
				}
				owners[key] = owner
			}
			selected = field.EmptyInputTargets
		default:
			return nil, false, fmt.Errorf("工作流字段 %s.%s 的空素材策略无效", field.NodeID, field.FieldName)
		}
		index := field.SourceIndex
		if field.ImageOrder > 0 {
			index = field.ImageOrder - 1
		}
		if index < 0 {
			index = 0
		}
		if index < counts[kind] || len(selected) == 0 {
			continue
		}
		if activePerNode[field.NodeID] > 1 {
			return nil, false, fmt.Errorf("工作流节点 %s 有多个素材字段，请先拆分映射", field.NodeID)
		}
		for _, target := range selected {
			targets[target.NodeID+"\x00"+target.InputName] = target
		}
	}
	if len(targets) == 0 {
		return graph, false, nil
	}
	encoded, err := json.Marshal(graph)
	if err != nil {
		return nil, false, fmt.Errorf("工作流 JSON 编码失败：%w", err)
	}
	var copy map[string]interface{}
	if err := json.Unmarshal(encoded, &copy); err != nil {
		return nil, false, fmt.Errorf("工作流 JSON 解析失败：%w", err)
	}
	for _, target := range targets {
		node, _ := copy[target.NodeID].(map[string]interface{})
		inputs, _ := node["inputs"].(map[string]interface{})
		delete(inputs, target.InputName)
	}
	return copy, true, nil
}

func workflowInputTargetValid(graph map[string]interface{}, field Field, target InputTarget) bool {
	for _, candidate := range workflowInputTargets(graph, field) {
		if candidate.NodeID == target.NodeID && candidate.InputName == target.InputName &&
			candidate.SourceNodeID == target.SourceNodeID && candidate.SourceOutputIndex == target.SourceOutputIndex &&
			candidate.SourceClassType == target.SourceClassType && candidate.TargetClassType == target.TargetClassType && slices.Equal(candidate.Path, target.Path) {
			return true
		}
	}
	return false
}

// These core nodes have one IMAGE input and one IMAGE output (port 0).
// Keep this list aligned with workflow-image-inputs.ts and the shared fixture.
func workflowSingleImageTransform(classType string) bool {
	switch classType {
	case "ImageScale", "ImageScaleBy", "ImageCrop", "ImageCropV2":
		return true
	}
	return false
}

func workflowInputTargets(graph map[string]interface{}, field Field) []InputTarget {
	source, _ := graph[field.NodeID].(map[string]interface{})
	sourceInputs, _ := source["inputs"].(map[string]interface{})
	value, exists := sourceInputs[field.FieldName]
	switch value.(type) {
	case string, float64, int, bool, json.Number:
	default:
		return nil
	}
	sourceClass := stringValue(source["class_type"])
	if !exists || sourceClass == "" {
		return nil
	}
	type edge struct{ nodeID, inputName, classType string }
	outgoing := map[string][]edge{}
	for id, raw := range graph {
		node, _ := raw.(map[string]interface{})
		classType := stringValue(node["class_type"])
		if classType == "" {
			continue
		}
		inputs, _ := node["inputs"].(map[string]interface{})
		for name, value := range inputs {
			if isWorkflowLinkValue(value) && workflowScalarString(value.([]interface{})[1]) == "0" {
				sourceID := stringValue(value.([]interface{})[0])
				outgoing[sourceID] = append(outgoing[sourceID], edge{nodeID: id, inputName: name, classType: classType})
			}
		}
	}
	var result []InputTarget
	visited := map[string]bool{field.NodeID: true}
	var follow func(string, []InputPathStep)
	follow = func(sourceID string, path []InputPathStep) {
		for _, edge := range outgoing[sourceID] {
			if visited[edge.nodeID] {
				continue
			}
			if workflowSingleImageTransform(edge.classType) {
				if len(path) >= 64 || sourceClass != "LoadImage" || field.FieldName != "image" || workflowMediaKind(field) != "image" || edge.inputName != "image" {
					continue
				}
				node, _ := graph[edge.nodeID].(map[string]interface{})
				inputs, _ := node["inputs"].(map[string]interface{})
				linkedControl := false
				for name, value := range inputs {
					if link, ok := value.([]interface{}); name != "image" && ok && len(link) == 2 {
						linkedControl = true
					}
				}
				if linkedControl {
					continue
				}
				visited[edge.nodeID] = true
				follow(edge.nodeID, append(append([]InputPathStep(nil), path...), InputPathStep{NodeID: edge.nodeID, InputName: edge.inputName, ClassType: edge.classType}))
				delete(visited, edge.nodeID)
				continue
			}
			if edge.classType == "ImageBatch" {
				continue
			}
			result = append(result, InputTarget{NodeID: edge.nodeID, InputName: edge.inputName, SourceNodeID: field.NodeID, SourceOutputIndex: 0, SourceClassType: sourceClass, TargetClassType: edge.classType, Path: append([]InputPathStep(nil), path...)})
		}
	}
	follow(field.NodeID, nil)
	sort.Slice(result, func(i, j int) bool {
		return result[i].NodeID+"\x00"+result[i].InputName < result[j].NodeID+"\x00"+result[j].InputName
	})
	return result
}

func workflowRecommendedImageTargets(graph map[string]interface{}, field Field) []InputTarget {
	source, _ := graph[field.NodeID].(map[string]interface{})
	if stringValue(source["class_type"]) != "LoadImage" || field.FieldName != "image" {
		return nil
	}
	var result []InputTarget
	for _, target := range workflowInputTargets(graph, field) {
		if dynamicReferenceImageInput.MatchString(target.InputName) {
			result = append(result, target)
		}
	}
	return result
}
