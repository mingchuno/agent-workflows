# Continue publication in the implementation session and inspect through commands

Publication resumes the successful implementation session after validation, with
`useNewSession` as an escape hatch; review starts independently. All stages receive
implementation-level provider permissions and inspect Git/source through commands,
removing the patch capture and navigation pipeline. Publication, review and format
correction still require an unchanged checkout: post-invocation checks reject
source/index/branch/revision mutation while preserving work for inspection. This
permits ordinary shell processing and scratch writes, at the cost of relying on
stage instructions and mutation detection rather than enforced inspection-only
permissions; it preserves separate durable steps and explicit interrupted-work
retry rules.
