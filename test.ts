export type Schema = DefinedType | DefinedType[];
type DefinedType = PrimitiveType | ComplexType | LogicalType | string;
type PrimitiveType =
  | 'null'
  | 'boolean'
  | 'int'
  | 'long'
  | 'float'
  | 'double'
  | 'bytes'
  | 'string';
type ComplexType =
  | NamedType
  | RecordType
  | EnumType
  | MapType
  | ArrayType
  | FixedType;
type LogicalType = ComplexType & LogicalTypeExtension;

interface NamedType {
  type: PrimitiveType;
}

interface RecordType {
  type: 'record' | 'error';
  name: string;
  namespace?: string;
  doc?: string;
  aliases?: string[];
  fields: {
    name: string;
    doc?: string;
    type: Schema;
    default?: any;
    order?: 'ascending' | 'descending' | 'ignore';
  }[];
}

interface EnumType {
  type: 'enum';
  name: string;
  namespace?: string;
  aliases?: string[];
  doc?: string;
  symbols: string[];
}

interface ArrayType {
  type: 'array';
  items: Schema;
}

interface MapType {
  type: 'map';
  values: Schema;
}

interface FixedType {
  type: 'fixed';
  name: string;
  aliases?: string[];
  size: number;
}

interface LogicalTypeExtension {
  logicalType: string;
  [param: string]: any;
}

type ObjectType<S extends Schema> = S extends 'null' ? null
  : S extends 'boolean' ? boolean
  : S extends 'int' ? number
  : S extends 'long' ? bigint
  : S extends 'float' ? number
  : S extends 'double' ? number
  : S extends 'bytes' ? Buffer
  : S extends 'string' ? string
  : S extends RecordType ? {
    [key in S['fields'][number]['name']]: ObjectType<
      S['fields'][number]['type']
    >;
  }
  : S extends EnumType ? S['symbols'][number]
  : S extends ArrayType ? ObjectType<S['items']>[]
  : S extends MapType ? Record<string, ObjectType<S['values']>>
  : S extends FixedType ? Buffer
  : S extends DefinedType[] ? ObjectType<S[number]>
  : undefined;

let x: ObjectType<{ type: 'fixed'; name: 'abc'; size: 123 }>;
