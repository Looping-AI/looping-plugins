# looping-plugins

Independent capability modules for Looping agents, published as @looping/plugins with
one subpath export per plugin. Each plugin is a single factory that takes its config at
instantiation, declares the secrets and bindings it needs, and owns its own storage — so
a project's bundle grows only with what it actually imports, never with the size of the
library.
