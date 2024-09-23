import {
    Application,
    Context,
    Converter,
    DeclarationReflection,
    IntrinsicType,
    ParameterReflection,
    ReflectionFlag,
    ReflectionKind,
    SignatureReflection,
    SomeType,
    TypeScript as ts,
    UnionType,
} from "typedoc";

const PREFIX = "[typedoc-plugin-generic-signature-overloads]";
const TAG = "@expandGeneric";

declare module "typescript" {
    export interface TypeChecker {
        getTypeAliasInstantiation(
            symbol: Symbol,
            typeArguments: readonly Type[] | undefined,
            aliasSymbol?: Symbol,
            aliasTypeArguments?: readonly Type[],
        ): Type;
    }
}

export function load(app: Application) {
    let expandInProgress = false;

    app.on(Application.EVENT_BOOTSTRAP_END, () => {
        if (!app.options.isSet("modifierTags")) {
            app.options.setValue("modifierTags", [
                ...app.options.getValue("modifierTags"),
                TAG,
            ]);
        }
    });

    app.converter.on(Converter.EVENT_BEGIN, (context) => {
        for (const p of context.programs) {
            if (!p.getTypeChecker().getTypeAliasInstantiation) {
                throw new Error(
                    `${PREFIX} patch-package has not been run to expose the necessary internal APIs`,
                );
            }
        }
    });

    app.converter.on(
        Converter.EVENT_CREATE_SIGNATURE,
        (context, sig, decl, signature) => {
            if (
                expandInProgress ||
                !sig.comment?.hasModifier(TAG) ||
                !signature
            ) {
                return;
            }

            if (sig.kind !== ReflectionKind.CallSignature) {
                context.logger.warn(
                    `${PREFIX} ${TAG} only works on call signatures`,
                    decl,
                );
                return;
            }

            if (signature.typeParameters?.length !== 1) {
                context.logger.warn(
                    `${PREFIX} ${TAG} can only be specified on signatures with one type parameter`,
                    decl,
                );
                return;
            }

            const constraintType = signature.typeParameters[0].getConstraint();
            if (!constraintType || !constraintType.isUnion()) {
                context.logger.warn(
                    `${PREFIX} ${TAG} only works with type parameters constrained by a union`,
                    decl,
                );
                return;
            }

            // Remove the signature we're about to expand into overloads
            const parent = sig.parent;
            sig.comment.removeModifier(TAG);
            parent.project.removeReflection(sig);

            expandInProgress = true;
            for (const choice of constraintType.types) {
                // Contents of this loop are very closely based on createSignature in TypeDoc.
                // That function isn't exposed, and this hackery also has somewhat different requirements.

                const sigChoice = new SignatureReflection(
                    parent.name,
                    ReflectionKind.CallSignature,
                    parent,
                );
                sigChoice.comment = sig.comment.clone();

                const choiceCtx = context.withScope(sigChoice);

                // skip converting type parameters, there is only one, and we are creating
                // a separate signature for each choice.

                const parameterSymbols = signature.thisParameter
                    ? [signature.thisParameter, ...signature.parameters]
                    : signature.parameters;

                sigChoice.parameters = convertParameters(
                    choiceCtx,
                    sigChoice,
                    parameterSymbols,
                    decl?.parameters,
                    choice,
                );

                // Might also want a check here for type predicates at some point.
                // See signature.ts in typedoc, line 95
                sigChoice.type = convertType(
                    choiceCtx,
                    choice,
                    signature.getReturnType(),
                );

                context.registerReflection(sigChoice, undefined);
                parent.signatures ??= [];
                parent.signatures.push(sigChoice);

                context.converter.trigger(
                    Converter.EVENT_CREATE_SIGNATURE,
                    context,
                    sigChoice,
                    decl,
                    signature,
                );
            }

            expandInProgress = false;
        },
    );
}

function convertType(
    context: Context,
    replaceType: ts.Type,
    type: ts.Type,
): SomeType {
    if (type.flags & ts.TypeFlags.TypeParameter) {
        return context.converter.convertType(context, replaceType);
    }

    if (
        type.aliasSymbol &&
        type.aliasTypeArguments?.some(
            (t) => t.flags & ts.TypeFlags.TypeParameter,
        )
    ) {
        const replacedArgs = type.aliasTypeArguments.map((t) =>
            t.flags & ts.TypeFlags.TypeParameter ? replaceType : t,
        );
        const replacedAlias = context.checker.getTypeAliasInstantiation(
            type.aliasSymbol,
            replacedArgs,
        );

        return context.converter.convertType(context, replacedAlias);
    }

    return context.converter.convertType(context, type);
}

//////////////////////////////////////////////////////////
// Below here is effectively directly copied from TypeDoc
// with calls to convert types swapped with convertType.

function convertParameters(
    context: Context,
    sigRef: SignatureReflection,
    parameters: readonly ts.Symbol[],
    parameterNodes:
        | readonly ts.ParameterDeclaration[]
        | readonly ts.JSDocParameterTag[]
        | undefined,
    choice: ts.Type,
): ParameterReflection[] | undefined {
    // #2698 if `satisfies` is used to imply a this parameter, we might have
    // more parameters than parameter nodes and need to shift the parameterNode
    // access index. Very ugly, but it does the job.
    const parameterNodeOffset =
        parameterNodes?.length !== parameters.length ? -1 : 0;

    return parameters.map((param, i) => {
        const declaration = param.valueDeclaration;
        assert(
            !declaration ||
                ts.isParameter(declaration) ||
                ts.isJSDocParameterTag(declaration),
        );
        const paramRefl = new ParameterReflection(
            /__\d+/.test(param.name) ? "__namedParameters" : param.name,
            ReflectionKind.Parameter,
            sigRef,
        );
        if (declaration && ts.isJSDocParameterTag(declaration)) {
            paramRefl.comment = context.getJsDocComment(declaration);
        }
        paramRefl.comment ||= context.getComment(param, paramRefl.kind);

        context.registerReflection(paramRefl, param);
        context.converter.trigger(
            Converter.EVENT_CREATE_PARAMETER,
            context,
            paramRefl,
        );

        let type: ts.Type | undefined;
        if (declaration) {
            type = context.checker.getTypeOfSymbolAtLocation(
                param,
                declaration,
            );
        } else {
            type = (param as ts.Symbol & { type: ts.Type }).type;
        }

        if (
            declaration &&
            ts.isParameter(declaration) &&
            declaration.type?.kind === ts.SyntaxKind.ThisType
        ) {
            paramRefl.type = new IntrinsicType("this");
        } else {
            paramRefl.type = convertType(
                context.withScope(paramRefl),
                choice,
                type,
            );
        }

        let isOptional = false;
        if (declaration) {
            isOptional = ts.isParameter(declaration)
                ? !!declaration.questionToken ||
                  ts
                      .getJSDocParameterTags(declaration)
                      .some((tag) => tag.isBracketed)
                : declaration.isBracketed;
        }

        if (isOptional) {
            paramRefl.type = removeUndefined(paramRefl.type);
        }

        paramRefl.defaultValue = convertDefaultValue(
            parameterNodes?.[i + parameterNodeOffset],
        );
        paramRefl.setFlag(ReflectionFlag.Optional, isOptional);

        // If we have no declaration, then this is an implicitly defined parameter in JS land
        // because the method body uses `arguments`... which is always a rest argument
        let isRest = true;
        if (declaration) {
            isRest = ts.isParameter(declaration)
                ? !!declaration.dotDotDotToken
                : !!declaration.typeExpression &&
                  ts.isJSDocVariadicType(declaration.typeExpression.type);
        }

        paramRefl.setFlag(ReflectionFlag.Rest, isRest);
        return paramRefl;
    });
}

function assert(arg0: unknown): asserts arg0 {
    if (!arg0) {
        throw new Error("assertion failed");
    }
}

export function removeUndefined(type: SomeType): SomeType {
    if (type instanceof UnionType) {
        const types = type.types.filter((t) => {
            if (t instanceof IntrinsicType) {
                return t.name !== "undefined";
            }
            return true;
        });
        if (types.length === 1) {
            return types[0];
        }
        type.types = types;
        return type;
    }
    return type;
}

/**
 * Return the default value of the given node.
 *
 * @param node  The TypeScript node whose default value should be extracted.
 * @returns The default value as a string.
 */
export function convertDefaultValue(
    node: ts.Declaration | undefined,
): string | undefined {
    const anyNode = node as any;
    if (anyNode?.initializer) {
        return convertExpression(anyNode.initializer);
    } else {
        return undefined;
    }
}

export function convertExpression(expression: ts.Expression): string {
    switch (expression.kind) {
        case ts.SyntaxKind.StringLiteral:
        case ts.SyntaxKind.TrueKeyword:
        case ts.SyntaxKind.FalseKeyword:
        case ts.SyntaxKind.NullKeyword:
        case ts.SyntaxKind.NumericLiteral:
        case ts.SyntaxKind.PrefixUnaryExpression:
        case ts.SyntaxKind.Identifier:
            return expression.getText();
    }

    if (
        ts.isArrayLiteralExpression(expression) &&
        expression.elements.length === 0
    ) {
        return "[]";
    }

    if (
        ts.isObjectLiteralExpression(expression) &&
        expression.properties.length === 0
    ) {
        return "{}";
    }

    // a.b.c.d
    if (ts.isPropertyAccessExpression(expression)) {
        const parts = [expression.name.getText()];
        let iter = expression.expression;
        while (ts.isPropertyAccessExpression(iter)) {
            parts.unshift(iter.name.getText());
            iter = iter.expression;
        }

        if (ts.isIdentifier(iter)) {
            parts.unshift(iter.text);
            return parts.join(".");
        }
    }

    // More complex expressions are generally not useful in the documentation.
    // Show that there was a value, but not specifics.
    return "...";
}
