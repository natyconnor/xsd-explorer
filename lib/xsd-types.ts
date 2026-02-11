export type ComponentKind =
  | "element"
  | "complexType"
  | "simpleType"
  | "attribute"
  | "attributeGroup"
  | "group";

export type WarningCode = "MISSING_DEPENDENCY" | "UNRESOLVED_REFERENCE";

export interface DependencyEntry {
  kind: "include" | "import";
  location: string;
  namespace: string;
  resolvedFileName: string;
  exists: boolean;
}

export interface SchemaSummary {
  id: string;
  fileName: string;
  displayName: string;
  targetNamespace: string;
  rootElementIds: string[];
  componentIds: string[];
  dependencies: DependencyEntry[];
}

export interface QNameResolution {
  raw: string;
  namespace: string;
  local: string;
  isBuiltin: boolean;
  targetIds: string[];
  ambiguous: boolean;
  unresolvedReason?: string;
}

export interface RestrictionInfo {
  base?: string;
  enumerations: string[];
  facets: Record<string, string>;
}

export interface ElementField {
  id: string;
  path: string;
  depth: number;
  name: string;
  occurrence: string;
  documentation: string;
  rawTypeOrRef: string;
  resolution: QNameResolution | null;
  restrictions: RestrictionInfo;
}

export interface AttributeField {
  id: string;
  path: string;
  depth: number;
  name: string;
  use: string;
  documentation: string;
  rawTypeOrRef: string;
  resolution: QNameResolution | null;
  restrictions: RestrictionInfo;
}

export interface OutboundReference {
  attrName: string;
  rawValue: string;
  context: string;
  resolution: QNameResolution;
}

export interface InboundReference {
  sourceId: string;
  attrName: string;
  rawValue: string;
  context: string;
}

export interface BaseTypeInfo {
  raw: string;
  resolution: QNameResolution | null;
}

export interface ComponentSummary {
  id: string;
  schemaId: string;
  schemaFileName: string;
  kind: ComponentKind;
  name: string;
  namespace: string;
  docs: string[];
  restrictions: RestrictionInfo;
  enumerations: string[];
  baseType: BaseTypeInfo | null;
  elementFields: ElementField[];
  attributeFields: AttributeField[];
  references: OutboundReference[];
  usedBy: InboundReference[];
}

export interface IndexWarning {
  code: WarningCode;
  message: string;
  schemaId?: string;
  schemaFileName?: string;
  componentId?: string;
}

export interface XsdIndexSummary {
  schemaCount: number;
  componentCount: number;
  rootElementCount: number;
  warningCount: number;
}

export interface XsdIndex {
  version: number;
  generatedAt: string;
  sourceDirectory: string;
  summary: XsdIndexSummary;
  warnings: IndexWarning[];
  schemas: SchemaSummary[];
  components: ComponentSummary[];
}
