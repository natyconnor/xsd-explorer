#!/usr/bin/env python3
"""Build a canonical JSON index from local XSD files.

This script reads all *.xsd files from an input directory and produces one
JSON document that powers the read-only schema explorer UI.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

XS_NS = "http://www.w3.org/2001/XMLSchema"
XS_TAG = f"{{{XS_NS}}}"
BUILTIN_NS = XS_NS
GLOBAL_KINDS = {
    "element",
    "complexType",
    "simpleType",
    "attribute",
    "group",
    "attributeGroup",
}
FACET_NAMES = [
    "maxLength",
    "minLength",
    "pattern",
    "length",
    "totalDigits",
    "fractionDigits",
    "minInclusive",
    "maxInclusive",
    "minExclusive",
    "maxExclusive",
]


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def xs(tag: str) -> str:
    return f"{XS_TAG}{tag}"


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def slugify(value: str) -> str:
    lowered = value.lower().strip()
    lowered = re.sub(r"[^a-z0-9._-]+", "-", lowered)
    lowered = re.sub(r"-{2,}", "-", lowered)
    return lowered.strip("-") or "item"


def parse_qname(raw: str) -> Tuple[Optional[str], str]:
    if ":" in raw:
        prefix, local = raw.split(":", 1)
        return prefix, local
    return None, raw


def collect_nsmap(xsd_path: Path) -> Dict[str, str]:
    nsmap: Dict[str, str] = {"xs": XS_NS, "xsd": XS_NS}
    for _, value in ET.iterparse(xsd_path, events=("start-ns",)):
        prefix, uri = value
        nsmap[prefix or ""] = uri
    return nsmap


def text_from_doc_node(node: ET.Element) -> str:
    return clean_text(" ".join(node.itertext()))


def extract_documentation(node: ET.Element) -> List[str]:
    docs: List[str] = []
    for ann in node.findall(xs("annotation")):
        for doc in ann.findall(xs("documentation")):
            text = text_from_doc_node(doc)
            if text:
                docs.append(text)
    return docs


def occurrence_string(node: ET.Element) -> str:
    min_occurs = node.get("minOccurs", "1")
    max_occurs = node.get("maxOccurs", "1")
    if min_occurs == "1" and max_occurs == "1":
        return "1..1"
    return f"{min_occurs}..{max_occurs}"


def restrictions_from_node(node: ET.Element) -> Dict[str, object]:
    restriction = node.find(xs("restriction"))
    if restriction is None:
        simple_type = node.find(xs("simpleType"))
        if simple_type is not None:
            restriction = simple_type.find(xs("restriction"))
    if restriction is None:
        return {"base": "", "enumerations": [], "facets": {}}

    base = restriction.get("base", "")
    enums = [
        enum.get("value", "")
        for enum in restriction.findall(xs("enumeration"))
        if enum.get("value") is not None
    ]
    facets: Dict[str, str] = {}
    for facet in FACET_NAMES:
        facet_node = restriction.find(xs(facet))
        if facet_node is not None and facet_node.get("value") is not None:
            facets[facet] = facet_node.get("value", "")

    return {
        "base": base,
        "enumerations": enums,
        "facets": facets,
    }


@dataclasses.dataclass
class Dependency:
    kind: str
    location: str
    namespace: str
    resolved_file_name: str
    exists: bool


@dataclasses.dataclass
class QNameResolution:
    raw: str
    namespace: str
    local: str
    is_builtin: bool
    target_ids: List[str]
    ambiguous: bool
    unresolved_reason: str


@dataclasses.dataclass
class Reference:
    attr_name: str
    raw_value: str
    context: str
    resolution: QNameResolution


@dataclasses.dataclass
class ElementField:
    id: str
    path: str
    depth: int
    name: str
    occurrence: str
    documentation: str
    raw_type_or_ref: str
    resolution: Optional[QNameResolution]
    restrictions: Dict[str, object]


@dataclasses.dataclass
class AttributeField:
    id: str
    path: str
    depth: int
    name: str
    use: str
    documentation: str
    raw_type_or_ref: str
    resolution: Optional[QNameResolution]
    restrictions: Dict[str, object]


@dataclasses.dataclass
class BaseType:
    raw: str
    resolution: Optional[QNameResolution]


@dataclasses.dataclass
class InboundReference:
    source_id: str
    attr_name: str
    raw_value: str
    context: str


@dataclasses.dataclass
class SchemaDoc:
    path: Path
    file_name: str
    id: str
    nsmap: Dict[str, str]
    target_namespace: str
    dependencies: List[Dependency]
    components: List["Component"]
    reachable_schema_files: set[str] = dataclasses.field(default_factory=set)

    @property
    def display_name(self) -> str:
        return self.path.stem


@dataclasses.dataclass
class Component:
    schema: SchemaDoc
    kind: str
    name: str
    node: ET.Element
    namespace: str
    docs: List[str]
    id: str = ""
    restrictions: Dict[str, object] = dataclasses.field(default_factory=dict)
    enumerations: List[str] = dataclasses.field(default_factory=list)
    base_type: Optional[BaseType] = None
    element_fields: List[ElementField] = dataclasses.field(default_factory=list)
    attribute_fields: List[AttributeField] = dataclasses.field(default_factory=list)
    references: List[Reference] = dataclasses.field(default_factory=list)
    incoming: List[InboundReference] = dataclasses.field(default_factory=list)


def parse_schema(xsd_path: Path) -> SchemaDoc:
    tree = ET.parse(xsd_path)
    root = tree.getroot()
    if local_name(root.tag) != "schema":
        raise ValueError(f"{xsd_path} is not an XSD schema")

    schema_id = f"schema-{slugify(xsd_path.stem)}"
    nsmap = collect_nsmap(xsd_path)
    target_namespace = root.get("targetNamespace", "")

    dependencies: List[Dependency] = []
    components: List[Component] = []

    for child in root:
        child_kind = local_name(child.tag)

        if child_kind in ("include", "import"):
            location = (child.get("schemaLocation") or "").strip()
            namespace = (child.get("namespace") or "").strip()
            resolved_file_name = ""
            exists = False
            if location and "://" not in location:
                resolved = (xsd_path.parent / location).resolve()
                resolved_file_name = resolved.name
                exists = resolved.exists()

            dependencies.append(
                Dependency(
                    kind=child_kind,
                    location=location,
                    namespace=namespace,
                    resolved_file_name=resolved_file_name,
                    exists=exists,
                )
            )
            continue

        if child_kind not in GLOBAL_KINDS:
            continue

        name = (child.get("name") or "").strip()
        if not name:
            continue

        docs = extract_documentation(child)
        components.append(
            Component(
                schema=None,  # set below
                kind=child_kind,
                name=name,
                node=child,
                namespace=target_namespace,
                docs=docs,
            )
        )

    schema = SchemaDoc(
        path=xsd_path,
        file_name=xsd_path.name,
        id=schema_id,
        nsmap=nsmap,
        target_namespace=target_namespace,
        dependencies=dependencies,
        components=[],
    )

    for component in components:
        component.schema = schema
    schema.components = components
    return schema


def assign_component_ids(schemas: Sequence[SchemaDoc]) -> None:
    used: Dict[str, int] = defaultdict(int)
    for schema in schemas:
        for component in schema.components:
            base = f"{schema.id}:{slugify(component.kind)}:{slugify(component.name)}"
            used[base] += 1
            component.id = f"{base}:{used[base]}"


def build_catalog(
    schemas: Sequence[SchemaDoc],
) -> Dict[Tuple[str, str], List[Component]]:
    by_qname: Dict[Tuple[str, str], List[Component]] = defaultdict(list)
    for schema in schemas:
        for component in schema.components:
            by_qname[(component.namespace, component.name)].append(component)
    return by_qname


def compute_reachable_schemas(schemas: Sequence[SchemaDoc]) -> None:
    by_file_name = {schema.file_name: schema for schema in schemas}
    for schema in schemas:
        visited: set[str] = set()
        stack: List[str] = [schema.file_name]
        while stack:
            current = stack.pop()
            if current in visited:
                continue
            visited.add(current)
            schema_doc = by_file_name.get(current)
            if not schema_doc:
                continue
            for dep in schema_doc.dependencies:
                if dep.exists and dep.resolved_file_name in by_file_name:
                    stack.append(dep.resolved_file_name)
        schema.reachable_schema_files = visited


def resolve_qname(
    raw_qname: str,
    schema: SchemaDoc,
    by_qname: Dict[Tuple[str, str], List[Component]],
    expected_kinds: Optional[Sequence[str]] = None,
) -> QNameResolution:
    prefix, local = parse_qname(raw_qname)
    namespace = schema.target_namespace if prefix is None else schema.nsmap.get(prefix, "")
    is_builtin = namespace == BUILTIN_NS or (prefix in ("xs", "xsd") and namespace in ("", BUILTIN_NS))

    matches = by_qname.get((namespace, local), [])
    if expected_kinds:
        allowed = set(expected_kinds)
        matches = [match for match in matches if match.kind in allowed]

    if not matches and prefix is None:
        local_matches: List[Component] = []
        for (candidate_ns, candidate_name), components in by_qname.items():
            if candidate_name != local:
                continue
            if expected_kinds:
                allowed = set(expected_kinds)
                local_matches.extend([component for component in components if component.kind in allowed])
            else:
                local_matches.extend(components)
        if len(local_matches) == 1:
            matches = local_matches

    if len(matches) > 1 and schema.reachable_schema_files:
        reachable_matches = [match for match in matches if match.schema.file_name in schema.reachable_schema_files]
        if reachable_matches:
            matches = reachable_matches

    if len(matches) > 1:
        same_schema = [match for match in matches if match.schema.file_name == schema.file_name]
        if same_schema:
            matches = same_schema

    unresolved_reason = ""
    if not is_builtin and not matches:
        unresolved_reason = "No matching component found"
        if prefix and namespace == "":
            unresolved_reason = f"Unknown namespace prefix '{prefix}'"

    return QNameResolution(
        raw=raw_qname,
        namespace=namespace,
        local=local,
        is_builtin=is_builtin,
        target_ids=[component.id for component in matches],
        ambiguous=len(matches) > 1,
        unresolved_reason=unresolved_reason,
    )


def expected_kinds_for_attr(attr_name: str, owner_tag: str) -> Optional[List[str]]:
    owner = local_name(owner_tag)
    if attr_name in ("type", "base"):
        return ["complexType", "simpleType"]
    if attr_name == "itemType":
        return ["simpleType"]
    if attr_name == "memberTypes":
        return ["simpleType"]
    if attr_name == "substitutionGroup":
        return ["element"]
    if attr_name == "ref":
        if owner == "element":
            return ["element"]
        if owner == "attribute":
            return ["attribute"]
        if owner == "group":
            return ["group"]
        if owner == "attributeGroup":
            return ["attributeGroup"]
    return None


def build_context(component: Component, node: ET.Element) -> str:
    if node is component.node:
        return f"{component.kind}:{component.name}"
    tag = local_name(node.tag)
    node_name = node.get("name") or node.get("ref") or "(anonymous)"
    return f"{component.kind}:{component.name} > {tag}:{node_name}"


def collect_references_for_component(
    component: Component,
    by_qname: Dict[Tuple[str, str], List[Component]],
) -> List[Reference]:
    references: List[Reference] = []
    dedupe: set[Tuple[str, str, str]] = set()

    for node in component.node.iter():
        for attr_name in ("type", "base", "ref", "itemType", "memberTypes", "substitutionGroup"):
            raw = node.get(attr_name)
            if not raw:
                continue
            values = raw.split() if attr_name == "memberTypes" else [raw]
            for value in values:
                expected_kinds = expected_kinds_for_attr(attr_name, node.tag)
                resolution = resolve_qname(value, component.schema, by_qname, expected_kinds)
                context = build_context(component, node)
                key = (attr_name, value, context)
                if key in dedupe:
                    continue
                dedupe.add(key)
                references.append(
                    Reference(
                        attr_name=attr_name,
                        raw_value=value,
                        context=context,
                        resolution=resolution,
                    )
                )

    references.sort(key=lambda item: (item.attr_name, item.raw_value, item.context))
    return references


def resolve_optional(
    raw_value: str,
    component: Component,
    by_qname: Dict[Tuple[str, str], List[Component]],
    expected_kinds: Optional[Sequence[str]],
) -> Optional[QNameResolution]:
    if not raw_value:
        return None
    return resolve_qname(raw_value, component.schema, by_qname, expected_kinds)


def infer_inline_type(node: ET.Element) -> str:
    complex_selectors = [
        "./" + xs("complexType") + "/" + xs("complexContent") + "/" + xs("extension"),
        "./" + xs("complexType") + "/" + xs("complexContent") + "/" + xs("restriction"),
        "./" + xs("complexType") + "/" + xs("simpleContent") + "/" + xs("extension"),
        "./" + xs("complexType") + "/" + xs("simpleContent") + "/" + xs("restriction"),
    ]
    for selector in complex_selectors:
        candidate = node.find(selector)
        if candidate is not None and candidate.get("base"):
            return candidate.get("base", "")

    simple_type = node.find(xs("simpleType"))
    if simple_type is None:
        return ""
    restriction = simple_type.find(xs("restriction"))
    if restriction is None:
        return ""
    return restriction.get("base", "")


def field_depth(path: str) -> int:
    return max(len([chunk for chunk in path.split("/") if chunk]) - 1, 0)


def collect_element_fields(
    component: Component,
    by_qname: Dict[Tuple[str, str], List[Component]],
) -> List[ElementField]:
    fields: List[ElementField] = []
    counter = 0

    container_tags = {
        "sequence",
        "choice",
        "all",
        "group",
        "complexType",
        "complexContent",
        "simpleContent",
        "extension",
        "restriction",
    }

    def walk(node: ET.Element, current_path: str) -> None:
        nonlocal counter
        for child in list(node):
            tag = local_name(child.tag)
            if tag == "element":
                counter += 1
                name = child.get("name") or child.get("ref") or "(anonymous)"
                path = f"{current_path}/{name}" if current_path else name

                raw_type_or_ref = child.get("ref") or child.get("type") or ""
                if not raw_type_or_ref:
                    raw_type_or_ref = infer_inline_type(child)

                expected_kinds = ["element"] if child.get("ref") else ["complexType", "simpleType"]
                resolution = resolve_optional(raw_type_or_ref, component, by_qname, expected_kinds)
                docs = "; ".join(extract_documentation(child))
                restrictions = restrictions_from_node(child)

                fields.append(
                    ElementField(
                        id=f"{component.id}:element-field:{counter}",
                        path=path,
                        depth=field_depth(path),
                        name=name,
                        occurrence=occurrence_string(child),
                        documentation=docs,
                        raw_type_or_ref=raw_type_or_ref,
                        resolution=resolution,
                        restrictions=restrictions,
                    )
                )
                walk(child, path)
            elif tag in container_tags:
                walk(child, current_path)

    seed = component.name if component.kind in ("element", "complexType") else ""
    walk(component.node, seed)
    fields.sort(key=lambda item: item.path)
    return fields


def collect_attribute_fields(
    component: Component,
    by_qname: Dict[Tuple[str, str], List[Component]],
) -> List[AttributeField]:
    fields: List[AttributeField] = []
    counter = 0

    container_tags = {
        "sequence",
        "choice",
        "all",
        "group",
        "complexType",
        "complexContent",
        "simpleContent",
        "extension",
        "restriction",
    }

    def walk(node: ET.Element, current_path: str) -> None:
        nonlocal counter
        for child in list(node):
            tag = local_name(child.tag)
            if tag == "attribute":
                counter += 1
                name = child.get("name") or child.get("ref") or "(anonymous)"
                path = f"{current_path}/@{name}" if current_path else f"@{name}"
                raw_type_or_ref = child.get("type") or child.get("ref") or ""
                if not raw_type_or_ref:
                    raw_type_or_ref = infer_inline_type(child)
                expected_kinds = ["attribute"] if child.get("ref") else ["simpleType"]
                resolution = resolve_optional(raw_type_or_ref, component, by_qname, expected_kinds)
                docs = "; ".join(extract_documentation(child))
                restrictions = restrictions_from_node(child)

                fields.append(
                    AttributeField(
                        id=f"{component.id}:attribute-field:{counter}",
                        path=path,
                        depth=field_depth(path),
                        name=name,
                        use=child.get("use", "optional"),
                        documentation=docs,
                        raw_type_or_ref=raw_type_or_ref,
                        resolution=resolution,
                        restrictions=restrictions,
                    )
                )
                walk(child, current_path)
            elif tag == "attributeGroup":
                counter += 1
                raw_ref = child.get("ref", "")
                path = f"{current_path}/@group:{raw_ref}" if current_path else f"@group:{raw_ref}"
                resolution = resolve_optional(raw_ref, component, by_qname, ["attributeGroup"])
                fields.append(
                    AttributeField(
                        id=f"{component.id}:attribute-field:{counter}",
                        path=path,
                        depth=field_depth(path),
                        name=raw_ref or "(attributeGroup)",
                        use="n/a",
                        documentation="",
                        raw_type_or_ref=raw_ref,
                        resolution=resolution,
                        restrictions={"base": "", "enumerations": [], "facets": {}},
                    )
                )
                walk(child, current_path)
            elif tag in container_tags:
                walk(child, current_path)

    seed = component.name if component.kind in ("element", "complexType") else ""
    walk(component.node, seed)
    fields.sort(key=lambda item: item.path)
    return fields


def collect_enum_values(component: Component) -> List[str]:
    values: List[str] = []
    for enum in component.node.findall(".//" + xs("enumeration")):
        value = enum.get("value")
        if value is not None:
            values.append(value)
    deduped: List[str] = []
    seen = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        deduped.append(value)
    return deduped


def collect_base_type(
    component: Component,
    by_qname: Dict[Tuple[str, str], List[Component]],
) -> Optional[BaseType]:
    namespace = {"xs": XS_NS}

    selectors = [
        "./xs:complexContent/xs:extension",
        "./xs:complexContent/xs:restriction",
        "./xs:simpleContent/xs:extension",
        "./xs:simpleContent/xs:restriction",
        "./xs:restriction",
        "./xs:simpleType/xs:restriction",
    ]

    raw = ""
    for selector in selectors:
        node = component.node.find(selector, namespace)
        if node is not None and node.get("base"):
            raw = node.get("base", "")
            break

    if not raw:
        return None

    resolution = resolve_qname(raw, component.schema, by_qname, ["complexType", "simpleType"])
    return BaseType(raw=raw, resolution=resolution)


def to_restriction_json(raw: Dict[str, object]) -> Dict[str, object]:
    return {
        "base": str(raw.get("base") or ""),
        "enumerations": [str(value) for value in raw.get("enumerations", [])],
        "facets": {str(k): str(v) for k, v in dict(raw.get("facets", {})).items()},
    }


def component_to_json(component: Component) -> Dict[str, object]:
    return {
        "id": component.id,
        "schemaId": component.schema.id,
        "schemaFileName": component.schema.file_name,
        "kind": component.kind,
        "name": component.name,
        "namespace": component.namespace,
        "docs": component.docs,
        "restrictions": to_restriction_json(component.restrictions),
        "enumerations": component.enumerations,
        "baseType": None
        if component.base_type is None
        else {
            "raw": component.base_type.raw,
            "resolution": None
            if component.base_type.resolution is None
            else resolution_to_json(component.base_type.resolution),
        },
        "elementFields": [
            {
                "id": field.id,
                "path": field.path,
                "depth": field.depth,
                "name": field.name,
                "occurrence": field.occurrence,
                "documentation": field.documentation,
                "rawTypeOrRef": field.raw_type_or_ref,
                "resolution": None if field.resolution is None else resolution_to_json(field.resolution),
                "restrictions": to_restriction_json(field.restrictions),
            }
            for field in component.element_fields
        ],
        "attributeFields": [
            {
                "id": field.id,
                "path": field.path,
                "depth": field.depth,
                "name": field.name,
                "use": field.use,
                "documentation": field.documentation,
                "rawTypeOrRef": field.raw_type_or_ref,
                "resolution": None if field.resolution is None else resolution_to_json(field.resolution),
                "restrictions": to_restriction_json(field.restrictions),
            }
            for field in component.attribute_fields
        ],
        "references": [
            {
                "attrName": reference.attr_name,
                "rawValue": reference.raw_value,
                "context": reference.context,
                "resolution": resolution_to_json(reference.resolution),
            }
            for reference in component.references
        ],
        "usedBy": [
            {
                "sourceId": edge.source_id,
                "attrName": edge.attr_name,
                "rawValue": edge.raw_value,
                "context": edge.context,
            }
            for edge in component.incoming
        ],
    }


def resolution_to_json(resolution: QNameResolution) -> Dict[str, object]:
    payload: Dict[str, object] = {
        "raw": resolution.raw,
        "namespace": resolution.namespace,
        "local": resolution.local,
        "isBuiltin": resolution.is_builtin,
        "targetIds": resolution.target_ids,
        "ambiguous": resolution.ambiguous,
    }
    if resolution.unresolved_reason:
        payload["unresolvedReason"] = resolution.unresolved_reason
    return payload


def schema_to_json(schema: SchemaDoc) -> Dict[str, object]:
    root_ids = [component.id for component in schema.components if component.kind == "element"]
    return {
        "id": schema.id,
        "fileName": schema.file_name,
        "displayName": schema.display_name,
        "targetNamespace": schema.target_namespace,
        "rootElementIds": root_ids,
        "componentIds": [component.id for component in schema.components],
        "dependencies": [
            {
                "kind": dependency.kind,
                "location": dependency.location,
                "namespace": dependency.namespace,
                "resolvedFileName": dependency.resolved_file_name,
                "exists": dependency.exists,
            }
            for dependency in schema.dependencies
        ],
    }


def parse_all_schemas(input_dir: Path) -> List[SchemaDoc]:
    schemas: List[SchemaDoc] = []
    for path in sorted(input_dir.glob("*.xsd")):
        schemas.append(parse_schema(path))
    return schemas


def create_index(input_dir: Path) -> Dict[str, object]:
    schemas = parse_all_schemas(input_dir)
    assign_component_ids(schemas)
    compute_reachable_schemas(schemas)
    by_qname = build_catalog(schemas)

    warnings: List[Dict[str, object]] = []

    components_by_id: Dict[str, Component] = {}
    for schema in schemas:
        for dep in schema.dependencies:
            if dep.location and not dep.exists:
                warnings.append(
                    {
                        "code": "MISSING_DEPENDENCY",
                        "message": (
                            f"{schema.file_name} {dep.kind} references missing schemaLocation "
                            f"'{dep.location}'"
                        ),
                        "schemaId": schema.id,
                        "schemaFileName": schema.file_name,
                    }
                )

        for component in schema.components:
            components_by_id[component.id] = component
            component.restrictions = restrictions_from_node(component.node)
            component.enumerations = collect_enum_values(component)
            component.base_type = collect_base_type(component, by_qname)
            component.element_fields = collect_element_fields(component, by_qname)
            component.attribute_fields = collect_attribute_fields(component, by_qname)
            component.references = collect_references_for_component(component, by_qname)

    incoming_dedupe: set[Tuple[str, str, str, str]] = set()
    for component in components_by_id.values():
        for reference in component.references:
            if not reference.resolution.target_ids:
                if not reference.resolution.is_builtin:
                    warnings.append(
                        {
                            "code": "UNRESOLVED_REFERENCE",
                            "message": (
                                f"{component.schema.file_name}:{component.kind}:{component.name} "
                                f"could not resolve '{reference.raw_value}'"
                            ),
                            "schemaId": component.schema.id,
                            "schemaFileName": component.schema.file_name,
                            "componentId": component.id,
                        }
                    )
                continue

            for target_id in reference.resolution.target_ids:
                target = components_by_id.get(target_id)
                if target is None:
                    continue
                edge_key = (target_id, component.id, reference.attr_name, reference.raw_value)
                if edge_key in incoming_dedupe:
                    continue
                incoming_dedupe.add(edge_key)
                target.incoming.append(
                    InboundReference(
                        source_id=component.id,
                        attr_name=reference.attr_name,
                        raw_value=reference.raw_value,
                        context=reference.context,
                    )
                )

    for component in components_by_id.values():
        component.incoming.sort(key=lambda item: (item.source_id, item.attr_name, item.raw_value, item.context))

    schemas_sorted = sorted(schemas, key=lambda schema: schema.file_name)
    components_sorted = sorted(
        components_by_id.values(), key=lambda component: (component.schema.file_name, component.kind, component.name, component.id)
    )

    root_element_count = sum(len([c for c in schema.components if c.kind == "element"]) for schema in schemas_sorted)

    return {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceDirectory": str(input_dir.resolve()),
        "summary": {
            "schemaCount": len(schemas_sorted),
            "componentCount": len(components_sorted),
            "rootElementCount": root_element_count,
            "warningCount": len(warnings),
        },
        "warnings": warnings,
        "schemas": [schema_to_json(schema) for schema in schemas_sorted],
        "components": [component_to_json(component) for component in components_sorted],
    }


def write_index(index_data: Dict[str, object], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(index_data, handle, indent=2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build XSD JSON index")
    parser.add_argument("--input", default="..", help="Directory containing .xsd files")
    parser.add_argument(
        "--output",
        default="public/data/xsd-index.json",
        help="Output JSON path",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_dir = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    if not input_dir.exists() or not input_dir.is_dir():
        raise SystemExit(f"Input directory does not exist: {input_dir}")

    index_data = create_index(input_dir)
    write_index(index_data, output_path)
    print(
        f"Wrote {index_data['summary']['componentCount']} components from "
        f"{index_data['summary']['schemaCount']} schemas to {output_path}"
    )


if __name__ == "__main__":
    main()
