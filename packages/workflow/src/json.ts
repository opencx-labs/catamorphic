export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type WorkflowTypeError<Message extends string, Details> = {
  readonly __catamorphicWorkflowTypeError: Message;
  readonly __catamorphicWorkflowTypeErrorDetails: Details;
};

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type IsNever<Value> = [Value] extends [never] ? true : false;

type JsonPropertyValue<Value extends object, Key extends keyof Value> =
  object extends Pick<Value, Key> ? Exclude<Value[Key], undefined> : Value[Key];

type JsonIncompatibleKeys<Value extends object> = {
  [Key in keyof Value]-?: Key extends string
    ? IsJsonCompatible<JsonPropertyValue<Value, Key>> extends true
      ? never
      : Key
    : Key;
}[keyof Value];

type IsJsonCompatibleMember<Value> = [Value] extends [JsonPrimitive]
  ? true
  : Value extends readonly (infer Item)[]
    ? IsJsonCompatible<Item>
    : Value extends (...args: never[]) => unknown
      ? false
      : Value extends object
        ? [JsonIncompatibleKeys<Value>] extends [never]
          ? true
          : false
        : false;

export type IsJsonCompatible<Value> =
  IsAny<Value> extends true
    ? false
    : IsNever<Value> extends true
      ? false
      : [JsonValue] extends [Value]
        ? true
        : false extends IsJsonCompatibleMember<Value>
          ? false
          : true;

export type AssertJsonCompatible<Value, Message extends string> =
  IsJsonCompatible<Value> extends true
    ? unknown
    : WorkflowTypeError<Message, Value>;
