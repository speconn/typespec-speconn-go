import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Operation,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
  IntrinsicType,
} from "@typespec/compiler";

export type EmitterOptions = {
  "emitter-output-dir": string;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

interface RpcInfo {
  name: string;
  originalName: string;
  path: string;
  inputType: Model | null;
  outputType: Model | null;
  isStream: boolean;
}

interface ServiceInfo {
  namespace: Namespace;
  iface: Interface;
  serviceName: string;
  serviceFQN: string;
  rpcs: RpcInfo[];
  models: Model[];
}

interface FileNames {
  types: string;
  server: string;
  client: string;
}

// ==================== Helpers ====================

function isStreamOp(_program: Program, op: Operation): boolean {
  const returnModel = op.returnType;
  if (returnModel && returnModel.kind === "Model" && returnModel.name && returnModel.name.includes("Stream")) return true;
  return false;
}

function resolveInputModel(op: Operation): Model | null {
  if (op.parameters && op.parameters.kind === "Model") {
    const params = op.parameters;
    if (params.name && params.name !== "") return params;
    if (params.sourceModels && params.sourceModels.length > 0) {
      for (const sm of params.sourceModels) {
        const src = sm.model;
        if (src.kind === "Model" && src.name && src.name !== "") return src;
      }
    }
    if (params.sourceModel && params.sourceModel.name && params.sourceModel.name !== "") {
      return params.sourceModel;
    }
  }
  return null;
}

function resolveOutputModel(op: Operation): Model | null {
  if (op.returnType && op.returnType.kind === "Model") return op.returnType;
  return null;
}

function computeProcedurePath(ns: Namespace, iface: Interface, op: Operation): string {
  const nsFQN = getNamespaceFullName(ns);
  return `/${nsFQN}.${iface.name}/${op.name}`;
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];

  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const nsFQN = getNamespaceFullName(ns);
      const serviceName = iface.name;
      const rpcs: RpcInfo[] = [];
      const models: Model[] = [];
      const seen = new Set<string>();

      for (const [opName, op] of iface.operations) {
        const path = computeProcedurePath(ns, iface, op);
        const inputModel = resolveInputModel(op);
        const outputModel = resolveOutputModel(op);

        if (inputModel && inputModel.name && !seen.has(inputModel.name)) {
          models.push(inputModel);
          seen.add(inputModel.name);
        }
        if (outputModel && outputModel.name && !seen.has(outputModel.name)) {
          models.push(outputModel);
          seen.add(outputModel.name);
        }

        rpcs.push({ name: opName.charAt(0).toLowerCase() + opName.slice(1), originalName: opName, path, inputType: inputModel, outputType: outputModel, isStream: isStreamOp(program, op) });
      }

      navigateTypesInNamespace(ns, {
        model: (m: Model) => {
          if (m.name && !seen.has(m.name)) { models.push(m); seen.add(m.name); }
        },
      });

      result.push({ namespace: ns, iface, serviceName, serviceFQN: `${nsFQN}.${serviceName}`, rpcs, models });
    }
  }

  for (const svc of services) collectFromNs(svc.type);

  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }

  return result;
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

// ==================== File Naming ====================

function snakeBase(s: string): string {
  return s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
}

function camelBase(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function fileNamesFor(serviceName: string, lang: string): FileNames {
  const lower = camelBase(serviceName);
  const snake = snakeBase(serviceName);
  switch (lang) {
    case "go":
      return { types: `${snake}_types.go`, server: `${snake}_server.go`, client: `${snake}_client.go` };
    case "node":
      return { types: `${lower}.types.ts`, server: `${lower}.server.ts`, client: `${lower}.client.ts` };
    case "web":
      return { types: `${lower}.types.ts`, server: "", client: `${lower}.client.ts` };
    case "python":
      return { types: `${snake}_types.py`, server: `${snake}_server.py`, client: `${snake}_client.py` };
    case "rust":
      return { types: `${snake}_types.rs`, server: `${snake}_server.rs`, client: `${snake}_client.rs` };
    case "kotlin":
      return { types: `${serviceName}Types.kt`, server: "", client: `${serviceName}Client.kt` };
    case "swift":
      return { types: `${serviceName}Types.swift`, server: "", client: `${serviceName}Client.swift` };
    case "dart":
      return { types: `${snake}.types.dart`, server: "", client: `${snake}.client.dart` };
    default:
      return { types: `${snake}_types`, server: `${snake}_server`, client: `${snake}_client` };
  }
}

// ==================== Type Mappers ====================

function isStringType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "string";
  if (type.kind === "Intrinsic") return (type as any).name === "string";
  return false;
}

function isIntType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "int8" || n === "int16" || n === "int32" || n === "int64" || n === "uint8" || n === "uint16" || n === "uint32" || n === "uint64" || n === "integer";
  }
  return false;
}

function isFloatType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "float" || n === "float32" || n === "float64" || n === "decimal";
  }
  return false;
}

function isBoolType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "boolean";
  if (type.kind === "Intrinsic") return (type as any).name === "boolean";
  return false;
}

function isArrayType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).indexer;
}

function arrayElementType(type: Type): Type {
  if (type.kind === "Model" && (type as Model).indexer) return (type as Model).indexer!.value;
  return type;
}

function typeToGo(type: Type): string {
  if (isStringType(type)) return "string";
  if (isIntType(type)) return "int64";
  if (isFloatType(type)) return "float64";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `[]${typeToGo(arrayElementType(type))}`;
  if (type.kind === "Model") return type.name || "any";
  return "any";
}

function typeToTs(type: Type): string {
  if (isStringType(type)) return "string";
  if (isIntType(type) || isFloatType(type)) return "number";
  if (isBoolType(type)) return "boolean";
  if (isArrayType(type)) return `${typeToTs(arrayElementType(type))}[]`;
  if (type.kind === "Model") return type.name || "unknown";
  return "unknown";
}

function typeToPython(type: Type): string {
  if (isStringType(type)) return "str";
  if (isIntType(type)) return "int";
  if (isFloatType(type)) return "float";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `list[${typeToPython(arrayElementType(type))}]`;
  if (type.kind === "Model") return type.name || "Any";
  return "Any";
}

function typeToRust(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "i64";
  if (isFloatType(type)) return "f64";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `Vec<${typeToRust(arrayElementType(type))}>`;
  if (type.kind === "Model") return type.name || "serde_json::Value";
  return "serde_json::Value";
}

function typeToKotlin(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "Long";
  if (isFloatType(type)) return "Double";
  if (isBoolType(type)) return "Boolean";
  if (isArrayType(type)) return `List<${typeToKotlin(arrayElementType(type))}>`;
  if (type.kind === "Model") return type.name || "Any";
  return "Any";
}

function typeToSwift(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "Int64";
  if (isFloatType(type)) return "Double";
  if (isBoolType(type)) return "Bool";
  if (isArrayType(type)) return `[${typeToSwift(arrayElementType(type))}]`;
  if (type.kind === "Model") return type.name || "Any";
  return "Any";
}

function typeToDart(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "int";
  if (isFloatType(type)) return "double";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `List<${typeToDart(arrayElementType(type))}>`;
  if (type.kind === "Model") return type.name || "dynamic";
  return "dynamic";
}

// ==================== Go Emitter ====================

function emitGo(program: Program, services: ServiceInfo[], outputDir: string): Promise<void[]> {
  const promises: Promise<void>[] = [];
  const pkg = `speconn_${snakeBase(services[0]?.namespace.name?.toLowerCase() ?? "svc")}`;

  for (const svc of services) {
    if (svc.rpcs.length === 0) continue;
    const fn = fileNamesFor(svc.serviceName, "go");
    const goExport = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const reqName = (rpc: RpcInfo) => rpc.inputType?.name || "struct{}";
    const resName = (rpc: RpcInfo) => rpc.outputType?.name || "struct{}";

    const types: string[] = [];
    types.push("// Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    types.push(`package ${pkg}\n`);
    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      types.push(`type ${m.name} struct {`);
      for (const f of fields) {
        const goName = f.name.charAt(0).toUpperCase() + f.name.slice(1);
        const tag = `\`json:"${f.name}${f.optional ? ",omitempty" : ""}"\``;
        const t = f.optional ? `*${typeToGo(f.type)}` : typeToGo(f.type);
        types.push(`\t${goName} ${t} ${tag}`);
      }
      types.push('}\n');
    }
    types.push(`const ${svc.serviceName}Name = "${svc.serviceFQN}"\n`);
    for (const rpc of svc.rpcs) {
      types.push(`const ${svc.serviceName}${goExport(rpc.originalName)}Procedure = "${rpc.path}"`);
    }
    types.push('');

    const server: string[] = [];
    server.push("// Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    server.push(`package ${pkg}\n`);
    server.push('import "github.com/speconn/speconn-go"\n');
    server.push(`type ${svc.serviceName}Handler interface {`);
    for (const rpc of svc.rpcs) {
      if (rpc.isStream) {
        server.push(`\t${goExport(rpc.originalName)}(ctx *speconn.SpeconnContext, req *${reqName(rpc)}, send func(*${resName(rpc)}) error) error`);
      } else {
        server.push(`\t${goExport(rpc.originalName)}(ctx *speconn.SpeconnContext, req *${reqName(rpc)}) (*${resName(rpc)}, error)`);
      }
    }
    server.push('}\n');
    server.push(`func New${svc.serviceName}Router(svc ${svc.serviceName}Handler, opts ...speconn.RouterOption) *speconn.SpeconnRouter {`);
    server.push(`\trouter := speconn.NewRouter(opts...)`);
    for (const rpc of svc.rpcs) {
      const expName = goExport(rpc.originalName);
      const procConst = `${svc.serviceName}${expName}Procedure`;
      if (rpc.isStream) {
        server.push(`\tspeconn.RegisterServerStream[${reqName(rpc)}, ${resName(rpc)}](router, ${procConst}, svc.${expName})`);
      } else {
        server.push(`\tspeconn.RegisterUnary[${reqName(rpc)}, ${resName(rpc)}](router, ${procConst}, svc.${expName})`);
      }
    }
    server.push(`\treturn router`);
    server.push('}\n');
    server.push(`type Unimplemented${svc.serviceName}Handler struct{}\n`);
    for (const rpc of svc.rpcs) {
      if (rpc.isStream) {
        server.push(`func (Unimplemented${svc.serviceName}Handler) ${goExport(rpc.originalName)}(ctx *speconn.SpeconnContext, req *${reqName(rpc)}, send func(*${resName(rpc)}) error) error {`);
        server.push(`\treturn speconn.NewError(speconn.CodeUnimplemented, "${svc.serviceFQN}.${goExport(rpc.originalName)} is not implemented")`);
      } else {
        server.push(`func (Unimplemented${svc.serviceName}Handler) ${goExport(rpc.originalName)}(ctx *speconn.SpeconnContext, req *${reqName(rpc)}) (*${resName(rpc)}, error) {`);
        server.push(`\treturn nil, speconn.NewError(speconn.CodeUnimplemented, "${svc.serviceFQN}.${goExport(rpc.originalName)} is not implemented")`);
      }
      server.push('}\n');
    }

    const client: string[] = [];
    client.push("// Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    client.push(`package ${pkg}\n`);
    client.push('import "strings"');
    client.push('import "github.com/speconn/speconn-go"\n');
    client.push(`type ${svc.serviceName}Client interface {`);
    for (const rpc of svc.rpcs) {
      if (rpc.isStream) {
        client.push(`\t${goExport(rpc.originalName)}(req *speconn.Request[${reqName(rpc)}]) ([]*speconn.Response[${resName(rpc)}], error)`);
      } else {
        client.push(`\t${goExport(rpc.originalName)}(req *speconn.Request[${reqName(rpc)}]) (*speconn.Response[${resName(rpc)}], error)`);
      }
    }
    client.push('}\n');
    const privClient = svc.serviceName.charAt(0).toLowerCase() + svc.serviceName.slice(1) + "Client";
    client.push(`func New${svc.serviceName}Client(baseURL string) ${svc.serviceName}Client {`);
    client.push(`\tbaseURL = strings.TrimRight(baseURL, "/")`);
    client.push(`\treturn &${privClient}{`);
    for (const rpc of svc.rpcs) {
      const procConst = `${svc.serviceName}${goExport(rpc.originalName)}Procedure`;
      client.push(`\t\t${rpc.name}: speconn.NewClient[${reqName(rpc)}, ${resName(rpc)}](baseURL, ${procConst}),`);
    }
    client.push(`\t}`);
    client.push('}\n');
    client.push(`type ${privClient} struct {`);
    for (const rpc of svc.rpcs) {
      client.push(`\t${rpc.name} *speconn.SpeconnClient[${reqName(rpc)}, ${resName(rpc)}]`);
    }
    client.push('}\n');
    for (const rpc of svc.rpcs) {
      if (rpc.isStream) {
        client.push(`func (c *${privClient}) ${goExport(rpc.originalName)}(req *speconn.Request[${reqName(rpc)}]) ([]*speconn.Response[${resName(rpc)}], error) {`);
        client.push(`\treturn c.${rpc.name}.Stream(req)`);
      } else {
        client.push(`func (c *${privClient}) ${goExport(rpc.originalName)}(req *speconn.Request[${reqName(rpc)}]) (*speconn.Response[${resName(rpc)}], error) {`);
        client.push(`\treturn c.${rpc.name}.Call(req)`);
      }
      client.push('}\n');
    }

    promises.push(emitFile(program, { path: `${outputDir}/${fn.types}`, content: types.join("\n") }));
    promises.push(emitFile(program, { path: `${outputDir}/${fn.server}`, content: server.join("\n") }));
    promises.push(emitFile(program, { path: `${outputDir}/${fn.client}`, content: client.join("\n") }));
  }
  return Promise.all(promises);
}

// ==================== Main Emitter ====================

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const services = collectServices(program);
  await emitGo(program, services, outputDir);
}
