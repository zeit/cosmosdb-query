import traverse from "@babel/traverse";
import * as aggregateFunctions from "./aggregate-functions";

type Context = {
  ast?: any;
  document?: any;
  aggregation?: boolean;
};

function transform(ctx: Context, node: { [x: string]: any }) {
  // eslint-disable-next-line no-use-before-define
  const def = definitions[node.type];
  if (!def) {
    throw new Error(`Invalid type: ${node.type}`);
  }

  return def(ctx, node);
}

function isAggregateFunction({
  type,
  name,
  udf
}: {
  type: string;
  name: any;
  udf: boolean;
}) {
  return (
    type === "scalar_function_expression" &&
    Object.prototype.hasOwnProperty.call(
      aggregateFunctions,
      name.name.toUpperCase()
    ) &&
    !udf
  );
}

function strictTrueNode(node: any) {
  return {
    type: "BinaryExpression",
    left: node,
    operator: "===",
    right: {
      type: "BooleanLiteral",
      value: true
    }
  };
}

function isNotUndefinedNode(argument: any) {
  return {
    type: "BinaryExpression",
    left: {
      type: "UnaryExpression",
      operator: "typeof",
      prefix: true,
      argument
    },
    operator: "!==",
    right: {
      type: "StringLiteral",
      value: "undefined"
    }
  };
}

function callHelperNode(name: string, ...args: any[]) {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: "$h"
      },
      property: {
        type: "Identifier",
        name
      }
    },
    arguments: args
  };
}

const definitions: { [key: string]: Function } = {
  array_constant(
    ctx: Context,
    { elements }: { elements: any[] }
  ): { type: string; elements: any[] } {
    return {
      type: "ArrayExpression",
      elements: elements.map(v => transform(ctx, v))
    };
  },

  boolean_constant(ctx: Context, { value }: { value: boolean }) {
    return {
      type: "BooleanLiteral",
      value
    };
  },

  collection_expression(
    ctx: Context,
    { expression }: { expression: any }
  ): any {
    return transform(ctx, expression);
  },

  collection_member_expression(
    ctx: Context,
    {
      object,
      property,
      computed
    }: { object: any; property: any; computed: boolean }
  ) {
    return {
      type: "MemberExpression",
      object: transform(ctx, object),
      property: transform(ctx, property),
      computed
    };
  },

  filter_condition(ctx: Context, { condition }: { condition: any }) {
    return {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: ctx.ast,
        property: {
          type: "Identifier",
          name: "filter"
        }
      },
      arguments: [
        {
          type: "ArrowFunctionExpression",
          params: ctx.document ? [ctx.document] : [],
          body: strictTrueNode(transform(ctx, condition))
        }
      ]
    };
  },

  from_source(
    ctx: Context,
    { expression, alias }: { expression: any; alias?: any }
  ) {
    return transform(ctx, alias || expression);
  },

  from_specification(
    ctx: Context,
    {
      source,
      joins
    }: {
      source: { expression: any; alias?: any; iteration?: boolean };
      joins?: { expression: any; alias?: any; iteration?: boolean }[];
    }
  ) {
    return [source, ...(joins || [])].reduce(
      (object, { expression, alias, iteration }) => {
        const exp = transform(ctx, expression);
        const node = alias ? transform(ctx, alias) : exp;
        const nameNode = node.property || node;

        if (!ctx.document) {
          if (exp.type !== "MemberExpression") {
            ctx.document = exp;
          } else {
            traverse({ type: "Program", body: [exp] } as any, {
              MemberExpression(path: any) {
                const { object: o } = path.node;
                if (o.type === "Identifier") {
                  ctx.document = o;
                  path.stop();
                }
              }
            });
          }
        }

        const { document } = ctx;

        ctx.document = {
          type: "ObjectPattern",
          properties: [
            ...(document.type === "ObjectPattern" ? document.properties : []),
            {
              type: "ObjectProperty",
              computed: false,
              shorthand: true,
              key: nameNode,
              value: nameNode
            }
          ]
        };

        if (iteration) {
          // e.g,
          //   FROM Families f
          //   JOIN c IN f.children
          //   JOIN p IN c.pets
          //
          // collection
          //   .reduce(($, Families) => [...$, { f: Families }], [])
          //   .reduce(($, { f }) => [...$, ...(f.children || []).map(c => ({ c, f }))], [])
          //   .reduce(($, { f, c }) => [...$, ...(c.pets || []).map(p => ({ c, f, p }))], [])
          return {
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              object,
              property: {
                type: "Identifier",
                name: "reduce"
              }
            },
            arguments: [
              {
                type: "ArrowFunctionExpression",
                params: [{ type: "Identifier", name: "$" }, document],
                body: {
                  type: "ArrayExpression",
                  elements: [
                    {
                      type: "SpreadElement",
                      argument: {
                        type: "Identifier",
                        name: "$"
                      }
                    },
                    {
                      type: "SpreadElement",
                      argument: {
                        type: "CallExpression",
                        callee: {
                          type: "MemberExpression",
                          object: {
                            type: "LogicalExpression",
                            left: exp,
                            operator: "||",
                            right: {
                              type: "ArrayExpression",
                              elements: []
                            }
                          },
                          property: {
                            type: "Identifier",
                            name: "map"
                          }
                        },
                        arguments: [
                          {
                            type: "ArrowFunctionExpression",
                            params: [nameNode],
                            body: {
                              type: "ObjectExpression",
                              properties: [
                                ...(document.type === "ObjectPattern"
                                  ? document.properties
                                  : []),
                                {
                                  type: "ObjectProperty",
                                  computed: false,
                                  key: nameNode,
                                  value: nameNode
                                }
                              ]
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              },
              {
                type: "ArrayExpression",
                elements: []
              }
            ]
          };
        }

        // e.g,
        //   FROM Families.children[0] c
        //
        // collection
        //   .reduce(($, Families) => [...$, { c: Families.children[0] }], [])
        //
        //   FROM Families f
        //   JOIN f.children
        //
        // collection
        //   .reduce(($, Families) => [...$, { f: Families }], [])
        //   .reduce(($, f) => (typeof f.children !== 'undefined' ? [...$, { f, children: f.children }] : $), [])
        return {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            object,
            property: {
              type: "Identifier",
              name: "reduce"
            }
          },
          arguments: [
            {
              type: "ArrowFunctionExpression",
              params: [{ type: "Identifier", name: "$" }, document],
              body: {
                type: "ConditionalExpression",
                test: isNotUndefinedNode(exp),
                consequent: {
                  type: "ArrayExpression",
                  elements: [
                    {
                      type: "SpreadElement",
                      argument: {
                        type: "Identifier",
                        name: "$"
                      }
                    },
                    {
                      type: "ObjectExpression",
                      properties: [
                        ...(document.type === "ObjectPattern"
                          ? document.properties
                          : []),
                        {
                          type: "ObjectProperty",
                          computed: false,
                          key: nameNode,
                          value: exp
                        }
                      ]
                    }
                  ]
                },
                alternate: {
                  type: "Identifier",
                  name: "$"
                }
              }
            },
            {
              type: "ArrayExpression",
              elements: []
            }
          ]
        };
      },
      ctx.ast
    );
  },

  identifier(ctx: Context, { name }: { name: string }) {
    return {
      type: "Identifier",
      name
    };
  },

  null_constant() {
    return { type: "NullLiteral" };
  },

  number_constant(ctx: Context, { value }: { value: number }) {
    return {
      type: "NumericLiteral",
      value
    };
  },

  object_constant(
    ctx: Context,
    { properties }: { properties: { key: any; value: any }[] }
  ) {
    return {
      type: "ObjectExpression",
      properties: properties.map(({ key, value }) => ({
        type: "ObjectProperty",
        key: transform(ctx, key),
        value: transform(ctx, value)
      }))
    };
  },

  object_property_list(
    ctx: Context,
    { properties }: { properties: { property: any; alias: any }[] }
  ) {
    let n = 0;
    return {
      type: "ObjectExpression",
      properties: properties.map(({ property, alias }) => {
        const key = alias || property.property;
        return {
          type: "ObjectProperty",
          key: key
            ? transform(ctx, key)
            : // eslint-disable-next-line no-plusplus
              { type: "Identifier", name: `$${++n}` },
          value: transform(ctx, property)
        };
      })
    };
  },

  parameter_name(ctx: Context, { name }: { name: string }) {
    return {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: "$p"
      },
      property: {
        type: "Identifier",
        name: name.slice(1)
      }
    };
  },

  scalar_array_expression(ctx: Context, { elements }: { elements: any[] }) {
    return {
      type: "ArrayExpression",
      elements: elements.map(v => transform(ctx, v))
    };
  },

  scalar_between_expression(
    ctx: Context,
    { value, begin, end }: { value: any; begin: any; end: any }
  ) {
    const left = transform(ctx, value);
    return {
      type: "BinaryExpression",
      left: {
        type: "BinaryExpression",
        left,
        operator: ">=",
        right: transform(ctx, begin)
      },
      operator: "&&",
      right: {
        type: "BinaryExpression",
        left,
        operator: "<=",
        right: transform(ctx, end)
      }
    };
  },

  scalar_binary_expression(
    ctx: Context,
    { left, operator, right }: { left: any; operator: string; right: any }
  ) {
    const l = transform(ctx, left);
    const r = transform(ctx, right);

    if (operator === "??") {
      // `typeof left !== "undefined" ? left : right`
      return {
        type: "ConditionalExpression",
        test: isNotUndefinedNode(l),
        consequent: l,
        alternate: r
      };
    }

    if (operator === "AND") {
      return callHelperNode("and", l, r);
    }
    if (operator === "OR") {
      return callHelperNode("or", l, r);
    }
    if (operator === "=") {
      return callHelperNode("equal", l, r);
    }
    if (operator === "!=" || operator === "<>") {
      return callHelperNode("notEqual", l, r);
    }
    if (
      operator === ">" ||
      operator === "<" ||
      operator === ">=" ||
      operator === "<="
    ) {
      return callHelperNode(
        "compare",
        {
          type: "StringLiteral",
          value: operator
        },
        l,
        r
      );
    }
    if (operator === "||") {
      return callHelperNode("concat", l, r);
    }

    return callHelperNode(
      "calculate",
      {
        type: "StringLiteral",
        value: operator
      },
      l,
      r
    );
  },

  scalar_conditional_expression(
    ctx: Context,
    {
      test,
      consequent,
      alternate
    }: { test: any; consequent: any; alternate: any }
  ) {
    return {
      type: "ConditionalExpression",
      test: strictTrueNode(transform(ctx, test)),
      consequent: transform(ctx, consequent),
      alternate: transform(ctx, alternate)
    };
  },

  scalar_function_expression(
    ctx: Context,
    {
      type,
      name,
      arguments: args,
      udf
    }: { type: string; name: any; arguments: any[]; udf: boolean }
  ) {
    const aggregation =
      ctx.aggregation && isAggregateFunction({ type, name, udf });

    const f = transform(ctx, name);
    f.name = f.name.toUpperCase();

    return {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: {
          type: "Identifier",
          // eslint-disable-next-line no-nested-ternary
          name: udf ? "udf" : aggregation ? "$a" : "$b"
        },
        property: f
      },
      arguments: aggregation
        ? args.map(a => ({
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              object: {
                type: "Identifier",
                name: "$_"
              },
              property: {
                type: "Identifier",
                name: "map"
              }
            },
            arguments: [
              {
                type: "ArrowFunctionExpression",
                params: ctx.document ? [ctx.document] : [],
                body: transform(ctx, a)
              }
            ]
          }))
        : args.map(a => transform(ctx, a))
    };
  },

  scalar_in_expression(
    ctx: Context,
    { value, list }: { value: any; list: any[] }
  ) {
    return {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: {
          type: "ArrayExpression",
          elements: list.map(l => transform(ctx, l))
        },
        property: {
          type: "Identifier",
          name: "includes"
        }
      },
      arguments: [transform(ctx, value)]
    };
  },

  scalar_member_expression(
    ctx: Context,
    {
      object,
      property,
      computed
    }: { object: any; property: any; computed: boolean }
  ) {
    return {
      type: "MemberExpression",
      object: transform(ctx, object),
      property: transform(ctx, property),
      computed
    };
  },

  scalar_object_expression(
    ctx: Context,
    { properties }: { properties: any[] }
  ) {
    return {
      type: "ObjectExpression",
      properties: properties.map(({ key, value }) => ({
        type: "ObjectProperty",
        key: transform(ctx, key),
        value: transform(ctx, value)
      }))
    };
  },

  scalar_unary_expression(
    ctx: Context,
    { operator, argument }: { operator: string; argument: any }
  ) {
    const node = transform(ctx, argument);

    if (operator === "NOT") {
      return callHelperNode("not", node);
    }

    return callHelperNode(
      "calculateUnary",
      {
        type: "StringLiteral",
        value: operator
      },
      node
    );
  },

  select_query(
    ctx: Context,
    {
      top,
      select,
      from,
      where,
      orderBy
    }: { top: any; select: any; from: any; where: any; orderBy: any }
  ) {
    if (from) {
      ctx.ast = {
        type: "Identifier",
        name: "$c"
      };
      ctx.ast = transform(ctx, from);
    } else {
      ctx.ast = {
        type: "ArrayExpression",
        elements: [
          {
            type: "NullLiteral"
          }
        ]
      };
    }

    if (where) {
      ctx.ast = transform(ctx, where);
    }

    if (orderBy) {
      ctx.ast = transform(ctx, orderBy);
    }

    if (top) {
      ctx.ast = transform(ctx, top);
    }

    ctx.ast = transform(ctx, select);

    return {
      type: "ArrowFunctionExpression",
      params: [
        // aggregate functions
        {
          type: "Identifier",
          name: "$a"
        },
        // built-in functions
        {
          type: "Identifier",
          name: "$b"
        },
        // document array (collection)
        {
          type: "Identifier",
          name: "$c"
        },
        // helper functions
        {
          type: "Identifier",
          name: "$h"
        },
        // udf
        {
          type: "Identifier",
          name: "udf"
        },
        // parameters
        {
          type: "Identifier",
          name: "$p"
        },
        // intermediate cache
        {
          type: "Identifier",
          name: "$_"
        }
      ],
      body: callHelperNode("stripUndefined", ctx.ast)
    };
  },

  select_specification(
    ctx: Context,
    {
      "*": all,
      properties,
      value
    }: { "*": boolean; properties?: { properties: any[] }; value: any }
  ) {
    if (all) {
      if (ctx.document.properties > 1) {
        throw new Error("'SELECT *' is only valid with a single input set.");
      }

      return {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          object: ctx.ast,
          property: {
            type: "Identifier",
            name: "map"
          }
        },
        arguments: [
          {
            type: "ArrowFunctionExpression",
            params: [ctx.document],
            body: ctx.document.properties[0]
          }
        ]
      };
    }

    ctx.aggregation = properties
      ? properties.properties.some(({ property }) =>
          isAggregateFunction(property)
        )
      : isAggregateFunction(value);
    if (ctx.aggregation) {
      // `($ = $c.filter(), [{ $1: COUNT($.map(c => c.id)), $2: ... }])`
      return {
        type: "SequenceExpression",
        expressions: [
          // cache filtered result to a variable
          {
            type: "AssignmentExpression",
            left: {
              type: "Identifier",
              name: "$_"
            },
            operator: "=",
            right: ctx.ast
          },
          {
            type: "ArrayExpression",
            elements: [transform(ctx, properties || value)]
          }
        ]
      };
    }

    return {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: ctx.ast,
        property: {
          type: "Identifier",
          name: "map"
        }
      },
      arguments: [
        {
          type: "ArrowFunctionExpression",
          params: ctx.document ? [ctx.document] : [],
          body: transform(ctx, properties || value)
        }
      ]
    };
  },

  sort_specification(ctx: Context, { expressions }: { expressions: any[] }) {
    return callHelperNode(
      "sort",
      ctx.ast,
      ...expressions.map(e => transform(ctx, e))
    );
  },

  sort_expression(
    ctx: Context,
    { expression, order }: { expression: any; order: string }
  ) {
    const node = transform(ctx, expression);

    const elements: any[] = [];
    if (node.type === "MemberExpression") {
      traverse({ type: "Program", body: [node] } as any, {
        MemberExpression(path: any) {
          elements.unshift({
            type: "StringLiteral",
            value: path.node.property.name
          });

          if (path.node.object.type === "Identifier") {
            elements.unshift({
              type: "StringLiteral",
              value: path.node.object.name
            });
          }
        }
      });
    }

    return {
      type: "ArrayExpression",
      elements: [
        {
          type: "ArrayExpression",
          elements
        },
        {
          type: "BooleanLiteral",
          value: order === "DESC"
        }
      ]
    };
  },

  string_constant(ctx: Context, { value }: { value: string }) {
    return {
      type: "StringLiteral",
      value
    };
  },

  top_specification(ctx: Context, { value }: { value: any }) {
    return {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: ctx.ast,
        property: {
          type: "Identifier",
          name: "slice"
        }
      },
      arguments: [
        {
          type: "NumericLiteral",
          value: 0
        },
        transform(ctx, value)
      ]
    };
  },

  undefined_constant() {
    return {
      type: "Identifier",
      name: "undefined"
    };
  }
};

export default (sqlAst: { [x: string]: any }) => transform({}, sqlAst);