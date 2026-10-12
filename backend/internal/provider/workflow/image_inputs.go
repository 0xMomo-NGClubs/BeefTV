package workflow

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var dynamicReferenceImageInput = regexp.MustCompile(`^reference_images\.reference_image_[0-9]+$`)

// Only dynamic list ports can be omitted without guessing a custom node's required
// input schema. Fixed inputs, masks, disabled mappings and independent outputs stay intact.
func workflowWithProvidedImages(graph map[string]interface{}, fields []Field, imageCount int, policy string) (map[string]interface{}, bool, error) {
	if policy == "retain" {
		return graph, false, nil
	}
	if policy != "" && policy != "disconnect" {
		return nil, false, fmt.Errorf("不支持的参考图片默认策略：%s", policy)
	}
	omitted := map[string]bool{}
	for _, field := range fields {
		if field.Required || field.Enabled != nil && !*field.Enabled || isRunningHubUnsafeInternalField(graph, field) {
			continue
		}
		source := strings.NewReplacer("_", "", "-", "").Replace(normalizeWorkflowFieldSource(field))
		if source != "referenceimage" && source != "referenceimages" && source != "image" {
			continue
		}
		index := field.SourceIndex
		if field.ImageOrder > 0 {
			index = field.ImageOrder - 1
		}
		if index >= 0 && index < imageCount {
			continue
		}
		node, _ := graph[strings.TrimSpace(field.NodeID)].(map[string]interface{})
		inputs, _ := node["inputs"].(map[string]interface{})
		// A scalar filename on LoadImage is the mapped source of this IMAGE output.
		// Other loaders may combine inputs, so they need an explicit future schema.
		if stringValue(node["class_type"]) == "LoadImage" && field.FieldName == "image" && !isWorkflowLinkValue(inputs["image"]) {
			omitted[strings.TrimSpace(field.NodeID)] = true
		}
	}
	var changed bool
	for _, raw := range graph {
		node, _ := raw.(map[string]interface{})
		inputs, _ := node["inputs"].(map[string]interface{})
		for name, value := range inputs {
			if dynamicReferenceImageInput.MatchString(name) && isWorkflowLinkValue(value) && workflowScalarString(value.([]interface{})[1]) == "0" && omitted[stringValue(value.([]interface{})[0])] {
				changed = true
			}
		}
	}
	if !changed {
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
	for _, raw := range copy {
		node, _ := raw.(map[string]interface{})
		inputs, _ := node["inputs"].(map[string]interface{})
		for name, value := range inputs {
			if dynamicReferenceImageInput.MatchString(name) && isWorkflowLinkValue(value) && workflowScalarString(value.([]interface{})[1]) == "0" && omitted[stringValue(value.([]interface{})[0])] {
				delete(inputs, name)
			}
		}
	}
	return copy, true, nil
}
