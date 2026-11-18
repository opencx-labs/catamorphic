# Review repository

The repository the review end-to-end test (`../../review.container.test.ts`)
reviews: `main/` is its main branch (a Node package with a pnpm lockfile and a
test script), `pull-1/` the files its pull request's first head changes, and
`pull-2/` what its second push changes. `pull-1/test/probe.js` is what the
pull request plants: it looks for any credential the code under review can
read and tries each against the review chat's model through Work's gateway.
