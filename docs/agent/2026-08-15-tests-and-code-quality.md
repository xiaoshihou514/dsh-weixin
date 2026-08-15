# Test layout and code-quality pass

The test suite now lives under `tests/`, mirroring production module names while keeping published TypeScript sources under `src/`. Test imports explicitly cross into `../src`; the build excludes the test directory and Vitest continues discovering it without additional configuration.

The code-quality review used the codetaste TypeScript rubric. The main readability issue was protocol dispatch encoded as nested conditional expressions. Inbound wire media selection is now a named `downloadSpec` switch, making the numeric iLink item variants and their field mappings visible in one place. MIME lookup tables were also moved out of the hot function and the fallback chain became a keyed lookup. Repeated anonymous Harness service casts now have named local interfaces.

Imperative loops remain where they preserve early exit, sequential network/file operations, bounded retry behavior, or incremental state. Replacing those with array combinators would obscure ordering or allocate intermediate collections without improving the model.
