// Huly operations used by the n8n automation.
// Field names and call shapes follow hcengineering/huly-examples (platform-api) and
// the v0.7.426 tracker model (Issue.blockedBy, Issue.parents, ChatMessage.message).

const { connect, NodeWebSocketFactory } = require('@hcengineering/api-client')
const { createHash } = require('node:crypto')
const core = require('@hcengineering/core').default
const contact = require('@hcengineering/contact').default
const { generateId, SortingOrder } = require('@hcengineering/core')
const { makeRank } = require('@hcengineering/rank')
const tracker = require('@hcengineering/tracker').default
const { IssuePriority } = require('@hcengineering/tracker')
const tags = require('@hcengineering/tags').default
const task = require('@hcengineering/task').default
const chunter = require('@hcengineering/chunter').default
const { markdownToMarkup, markupToMarkdown } = require('@hcengineering/text-markdown')
const { jsonToMarkup, markupToJSON } = require('@hcengineering/text-core')

const HULY_URL = process.env.HULY_URL
const HULY_WORKSPACE = process.env.HULY_WORKSPACE
const READY_STATUS = process.env.READY_STATUS ?? 'Ready'
const READY_LABEL = process.env.READY_LABEL ?? 'ready'
const DEPENDS_ON_RE = /^\s*Depends-On:\s*(.+)$/im

class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

// ---------- connections (one per caller token; the token is the caller's Huly identity) ----------

const clients = new Map()
const keyOf = (token) => createHash('sha256').update(token).digest('hex')

function getClient (token) {
  if (!token) throw new HttpError(401, 'Authorization: Bearer <Huly token> is required')
  const key = keyOf(token)
  if (!clients.has(key)) {
    const pending = connect(HULY_URL, {
      token,
      workspace: HULY_WORKSPACE,
      socketFactory: NodeWebSocketFactory,
      connectionTimeout: 30000
    }).catch((err) => {
      clients.delete(key)
      throw new HttpError(401, `Huly rejected the connection: ${err.message}`)
    })
    clients.set(key, pending)
  }
  return clients.get(key)
}

// Drop a connection after an unexpected error; the next call reconnects.
function resetClient (token) {
  const key = keyOf(token)
  const pending = clients.get(key)
  clients.delete(key)
  pending?.then((c) => c.close()).catch(() => {})
}

async function findProject (client, key) {
  const project =
    (await client.findOne(tracker.class.Project, { identifier: key })) ??
    (await client.findOne(tracker.class.Project, { name: key }))
  if (!project) throw new HttpError(404, `Huly project "${key}" not found (identifier or name)`)
  return project
}

async function findIssue (client, identifier) {
  const issue = await client.findOne(tracker.class.Issue, { identifier })
  if (!issue) throw new HttpError(404, `Huly issue "${identifier}" not found`)
  return issue
}

async function issuesByIdentifiers (client, identifiers) {
  if (!identifiers.length) return []
  const found = await client.findAll(tracker.class.Issue, { identifier: { $in: identifiers } })
  const missing = identifiers.filter((id) => !found.some((i) => i.identifier === id))
  if (missing.length) throw new HttpError(404, `Huly issues not found: ${missing.join(', ')}`)
  return found
}

async function projectStatuses (client, project) {
  const type = await client.findOne(task.class.ProjectType, { _id: project.type })
  const ids = (type?.statuses ?? []).map((s) => s._id)
  const statuses = await client.findAll(tracker.class.IssueStatus, { _id: { $in: ids } })
  return statuses.map((s) => ({ _id: s._id, name: s.name, category: categoryName(s.category) }))
}

function categoryName (category) {
  return Object.entries(task.statusCategory).find(([, v]) => v === category)?.[0] ?? String(category)
}

async function allStatuses (client) {
  const statuses = await client.findAll(tracker.class.IssueStatus, {})
  return new Map(statuses.map((s) => [s._id, { name: s.name, category: categoryName(s.category) }]))
}

// Assignee: "me" (the caller), null / "none" (nobody), a person's name as Huly shows it ("Last,First"), or a person uuid.
async function resolvePerson (client, who) {
  if (who === null || who === 'none') return null
  const persons = await client.findAll(contact.class.Person, {})
  let person
  if (who === 'me') {
    const own = await client.getAccount()
    person = persons.find((p) => p.personUuid === own.uuid)
  } else {
    person = persons.find((p) => p.personUuid === who) ?? persons.find((p) => p.name.toLowerCase() === String(who).toLowerCase())
  }
  if (!person) throw new HttpError(400, `Assignee "${who}" is not a person in this workspace`)
  return person._id
}

async function ensureLabel (client, title) {
  const existing = await client.findOne(tags.class.TagElement, { title, targetClass: tracker.class.Issue })
  if (existing) return existing
  const _id = generateId()
  await client.createDoc(
    tags.class.TagElement,
    core.space.Workspace,
    { title, description: '', targetClass: tracker.class.Issue, color: 11, category: tracker.category.Other },
    _id
  )
  return { _id, title, color: 11 }
}

async function description (client, issue) {
  if (!issue.description) return ''
  return await client.fetchMarkup(issue._class, issue._id, 'description', issue.description, 'markdown')
}

function dependsOnFromText (text) {
  const match = DEPENDS_ON_RE.exec(text ?? '')
  return match ? match[1].split(/[,\s]+/).filter(Boolean) : []
}

// ---------- serialisation ----------

async function summarize (client, issues, { withBody = false } = {}) {
  if (!issues.length) return []
  const statuses = await allStatuses(client)
  const ids = issues.map((i) => i._id)
  const labelRefs = await client.findAll(tags.class.TagReference, {
    attachedTo: { $in: ids },
    attachedToClass: tracker.class.Issue
  })
  const blockerIds = [...new Set(issues.flatMap((i) => (i.blockedBy ?? []).map((b) => b._id)))]
  const blockers = blockerIds.length
    ? await client.findAll(tracker.class.Issue, { _id: { $in: blockerIds } })
    : []
  const blockerById = new Map(blockers.map((b) => [b._id, b]))
  const assigneeIds = [...new Set(issues.map((i) => i.assignee).filter(Boolean))]
  const people = assigneeIds.length ? await client.findAll(contact.class.Person, { _id: { $in: assigneeIds } }) : []
  const personById = new Map(people.map((p) => [p._id, p.name]))

  const out = []
  for (const issue of issues) {
    const status = statuses.get(issue.status)
    const item = {
      identifier: issue.identifier,
      title: issue.title,
      project: issue.space,
      status: status?.name ?? null,
      statusCategory: status?.category ?? null,
      labels: labelRefs.filter((r) => r.attachedTo === issue._id).map((r) => r.title),
      parent: issue.parents?.[0]?.identifier ?? null,
      assignee: personById.get(issue.assignee) ?? null,
      blockedBy: (issue.blockedBy ?? []).map((b) => {
        const blocker = blockerById.get(b._id)
        return { identifier: blocker?.identifier ?? null, status: statuses.get(blocker?.status)?.name ?? null }
      }),
      modifiedOn: issue.modifiedOn
    }
    if (withBody) {
      item.description = await description(client, issue)
      item.dependsOn = dependsOnFromText(item.description)
    }
    out.push(item)
  }
  return out
}

// ---------- operations ----------

async function listProjects (client) {
  const projects = await client.findAll(tracker.class.Project, {})
  return projects.map((p) => ({ identifier: p.identifier, name: p.name }))
}

async function listIssues (client, { project, label, status, limit = 200 }) {
  const query = {}
  let statuses
  if (project) {
    const proj = await findProject(client, project)
    query.space = proj._id
    statuses = await projectStatuses(client, proj)
  }
  if (status) {
    const wanted = (statuses ?? [...(await allStatuses(client)).entries()].map(([_id, s]) => ({ _id, ...s })))
      .filter((s) => s.name.toLowerCase() === status.toLowerCase())
    if (!wanted.length) return []
    query.status = { $in: wanted.map((s) => s._id) }
  }
  if (label) {
    const tag = await client.findOne(tags.class.TagElement, { title: label, targetClass: tracker.class.Issue })
    if (!tag) return []
    const refs = await client.findAll(tags.class.TagReference, { tag: tag._id, attachedToClass: tracker.class.Issue })
    query._id = { $in: refs.map((r) => r.attachedTo) }
  }
  const issues = await client.findAll(tracker.class.Issue, query, {
    limit: Number(limit),
    sort: { modifiedOn: SortingOrder.Descending }
  })
  return await summarize(client, issues)
}

async function getIssue (client, identifier) {
  const issue = await findIssue(client, identifier)
  const [item] = await summarize(client, [issue], { withBody: true })
  const own = await client.getAccount()
  const ownIds = new Set([...(own.socialIds ?? []), own.primarySocialId].filter(Boolean))
  const messages = await client.findAll(
    chunter.class.ChatMessage,
    { attachedTo: issue._id },
    { sort: { createdOn: SortingOrder.Ascending } }
  )
  item.comments = messages.map((m) => ({
    id: m._id,
    author: m.createdBy,
    byMe: ownIds.has(m.createdBy),
    createdOn: m.createdOn,
    markdown: markupToMarkdown(markupToJSON(m.message))
  }))
  return item
}

async function createIssue (client, body) {
  const { project, title, description: md = '', labels = [], parent, blockedBy = [] } = body
  if (!project || !title) throw new HttpError(400, '"project" and "title" are required')
  const proj = await findProject(client, project)
  const parentIssue = parent ? await findIssue(client, parent) : undefined
  const blockers = await issuesByIdentifiers(client, blockedBy)
  const assignee = body.assignee === undefined ? null : await resolvePerson(client, body.assignee)

  const _id = generateId()
  const inc = await client.updateDoc(tracker.class.Project, core.space.Space, proj._id, { $inc: { sequence: 1 } }, true)
  const number = inc.object.sequence
  const last = await client.findOne(tracker.class.Issue, { space: proj._id }, { sort: { rank: SortingOrder.Descending } })
  const desc = md ? await client.uploadMarkup(tracker.class.Issue, _id, 'description', md, 'markdown') : null

  const parents = parentIssue
    ? [
        { parentId: parentIssue._id, identifier: parentIssue.identifier, parentTitle: parentIssue.title, space: parentIssue.space },
        ...(parentIssue.parents ?? [])
      ]
    : []

  await client.addCollection(
    tracker.class.Issue,
    proj._id,
    parentIssue?._id ?? proj._id,
    parentIssue ? tracker.class.Issue : proj._class,
    parentIssue ? 'subIssues' : 'issues',
    {
      title,
      description: desc,
      status: proj.defaultIssueStatus,
      number,
      kind: tracker.taskTypes.Issue,
      identifier: `${proj.identifier}-${number}`,
      priority: IssuePriority[body.priority] ?? IssuePriority.NoPriority,
      assignee,
      component: null,
      estimation: 0,
      remainingTime: 0,
      reportedTime: 0,
      reports: 0,
      subIssues: 0,
      parents,
      childInfo: [],
      dueDate: null,
      rank: makeRank(last?.rank, undefined),
      ...(blockers.length ? { blockedBy: blockers.map((b) => ({ _id: b._id, _class: b._class })) } : {})
    },
    _id
  )
  for (const label of labels) await addLabel(client, await findIssue(client, `${proj.identifier}-${number}`), label)
  return await getIssue(client, `${proj.identifier}-${number}`)
}

async function addLabel (client, issue, title) {
  const tag = await ensureLabel(client, title)
  const existing = await client.findOne(tags.class.TagReference, { attachedTo: issue._id, tag: tag._id })
  if (existing) return
  await client.addCollection(tags.class.TagReference, issue.space, issue._id, tracker.class.Issue, 'labels', {
    title: tag.title,
    color: tag.color,
    tag: tag._id
  })
}

async function removeLabel (client, issue, title) {
  const refs = await client.findAll(tags.class.TagReference, { attachedTo: issue._id, title })
  for (const ref of refs) {
    await client.removeCollection(tags.class.TagReference, issue.space, ref._id, issue._id, tracker.class.Issue, 'labels')
  }
}

async function updateLabels (client, identifier, { add = [], remove = [] }) {
  const issue = await findIssue(client, identifier)
  for (const title of remove) await removeLabel(client, issue, title)
  for (const title of add) await addLabel(client, issue, title)
  return await getIssue(client, identifier)
}

async function updateIssue (client, identifier, { status, blockedBy, assignee }) {
  const issue = await findIssue(client, identifier)
  const update = {}
  if (status) {
    const proj = await client.findOne(tracker.class.Project, { _id: issue.space })
    const match = (await projectStatuses(client, proj)).find((s) => s.name.toLowerCase() === status.toLowerCase())
    if (!match) throw new HttpError(400, `Status "${status}" does not exist in project ${proj.identifier}`)
    update.status = match._id
  }
  if (blockedBy) {
    const blockers = await issuesByIdentifiers(client, blockedBy)
    update.blockedBy = blockers.map((b) => ({ _id: b._id, _class: b._class }))
  }
  if (assignee !== undefined) update.assignee = await resolvePerson(client, assignee)
  if (Object.keys(update).length) await client.updateDoc(tracker.class.Issue, issue.space, issue._id, update)
  return await getIssue(client, identifier)
}

async function addComment (client, identifier, { markdown }) {
  if (!markdown) throw new HttpError(400, '"markdown" is required')
  const issue = await findIssue(client, identifier)
  const id = await client.addCollection(chunter.class.ChatMessage, issue.space, issue._id, tracker.class.Issue, 'comments', {
    message: jsonToMarkup(markdownToMarkup(markdown))
  })
  return { id }
}

// Ready = status "Ready" when the project has one, otherwise the "ready" label.
// Unblocked = every blocker (native blockedBy + "Depends-On:" line) is in a Won (done) status.
async function readyIssues (client, { project }) {
  const proj = await findProject(client, project)
  const statuses = await projectStatuses(client, proj)
  const readyStatus = statuses.find((s) => s.name.toLowerCase() === READY_STATUS.toLowerCase())
  const candidates = readyStatus
    ? await listIssues(client, { project, status: readyStatus.name })
    : await listIssues(client, { project, label: READY_LABEL })

  const ready = []
  for (const candidate of candidates) {
    const full = await getIssue(client, candidate.identifier)
    const blockerIds = [...new Set([...full.blockedBy.map((b) => b.identifier), ...full.dependsOn].filter(Boolean))]
    const blockers = blockerIds.length ? await summarize(client, await issuesByIdentifiers(client, blockerIds)) : []
    const open = blockers.filter((b) => b.statusCategory !== 'Won').map((b) => b.identifier)
    if (!open.length) ready.push(candidate)
  }
  return { mode: readyStatus ? 'status' : 'label', issues: ready }
}

async function lastActivity (client) {
  const issue = await client.findOne(tracker.class.Issue, {}, { sort: { modifiedOn: SortingOrder.Descending } })
  const message = await client.findOne(chunter.class.ChatMessage, {}, { sort: { modifiedOn: SortingOrder.Descending } })
  return { lastActivity: Math.max(issue?.modifiedOn ?? 0, message?.modifiedOn ?? 0) || null }
}

async function me (client) {
  const a = await client.getAccount()
  return { account: a.uuid ?? a._id ?? null, primarySocialId: a.primarySocialId ?? null, socialIds: a.socialIds ?? [] }
}

async function capabilities (client) {
  const hierarchy = client.getHierarchy()
  const projects = []
  for (const p of await client.findAll(tracker.class.Project, {})) {
    const statuses = await projectStatuses(client, p)
    projects.push({
      identifier: p.identifier,
      name: p.name,
      statuses: statuses.map((s) => `${s.name} (${s.category})`),
      hasReadyStatus: statuses.some((s) => s.name.toLowerCase() === READY_STATUS.toLowerCase())
    })
  }
  const withBlockers = await client.findAll(tracker.class.Issue, { blockedBy: { $exists: true } }, { limit: 50 })
  const labels = await client.findAll(tags.class.TagElement, { targetClass: tracker.class.Issue })
  return {
    account: await me(client),
    blockedByFieldInModel: hierarchy.findAttribute(tracker.class.Issue, 'blockedBy') !== undefined,
    issuesUsingBlockedBy: withBlockers.filter((i) => (i.blockedBy ?? []).length > 0).length,
    issueLabels: labels.map((l) => l.title),
    projects,
    recommendation: {
      ready: projects.length && projects.every((p) => p.hasReadyStatus)
        ? `status "${READY_STATUS}"`
        : `label "${READY_LABEL}" (add a "${READY_STATUS}" status to the project type to switch)`,
      dependencies: hierarchy.findAttribute(tracker.class.Issue, 'blockedBy') !== undefined
        ? 'native blockedBy (Depends-On: lines are also honoured)'
        : 'Depends-On: line in the description'
    }
  }
}

module.exports = {
  HttpError,
  getClient,
  resetClient,
  me,
  listProjects,
  listIssues,
  getIssue,
  createIssue,
  updateIssue,
  updateLabels,
  addComment,
  readyIssues,
  lastActivity,
  capabilities,
  dependsOnFromText
}
