// Offline check: the Huly model ids and helpers the bridge relies on exist in the pinned packages.
const assert = require('node:assert')
const tracker = require('@hcengineering/tracker').default
const tags = require('@hcengineering/tags').default
const task = require('@hcengineering/task').default
const chunter = require('@hcengineering/chunter').default
const core = require('@hcengineering/core').default
const { IssuePriority } = require('@hcengineering/tracker')
const { markdownToMarkup, markupToMarkdown } = require('@hcengineering/text-markdown')
const { jsonToMarkup, markupToJSON } = require('@hcengineering/text-core')
const { connect, NodeWebSocketFactory } = require('@hcengineering/api-client')
const { dependsOnFromText } = require('../src/huly')

for (const [name, value] of Object.entries({
  'tracker.class.Issue': tracker.class.Issue,
  'tracker.class.Project': tracker.class.Project,
  'tracker.class.IssueStatus': tracker.class.IssueStatus,
  'tracker.taskTypes.Issue': tracker.taskTypes.Issue,
  'tracker.category.Other': tracker.category.Other,
  'tags.class.TagElement': tags.class.TagElement,
  'tags.class.TagReference': tags.class.TagReference,
  'task.class.ProjectType': task.class.ProjectType,
  'task.statusCategory.Won': task.statusCategory.Won,
  'chunter.class.ChatMessage': chunter.class.ChatMessage,
  'core.space.Space': core.space.Space,
  'core.space.Workspace': core.space.Workspace
})) {
  assert.ok(value, `${name} is undefined`)
}
assert.equal(typeof IssuePriority.NoPriority, 'number')
assert.equal(typeof connect, 'function')
assert.ok(NodeWebSocketFactory)

const md = 'Gap found:\n\n- [ ] missing acceptance criteria\n- **edge case**: empty input'
const roundTrip = markupToMarkdown(markupToJSON(jsonToMarkup(markdownToMarkup(md))))
assert.match(roundTrip, /edge case/)

assert.deepEqual(dependsOnFromText('Intro\nDepends-On: SYN-12, SYN-14\nmore'), ['SYN-12', 'SYN-14'])
assert.deepEqual(dependsOnFromText('no deps here'), [])

console.log('smoke ok')
