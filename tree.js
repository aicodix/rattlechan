// The BBS tree (SPEC.md, Where a post goes): the signed posts among the
// station's entries, gathered into conversations, each on a board, in a
// direct conversation or elsewhere, and the ones for this station in its
// inbox.
//
// Only posts under a verified signature count, unsigned and Keyed ones
// stay in the log. A post received twice counts once, from its first
// arrival. Replies hang under their parents, in arrival order (SPEC.md,
// Ordering); a Reply whose parent never arrived starts a conversation of
// its own, elsewhere, until the parent comes.

import { walk, T } from './records.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');

// Every signed post of the entries by its ID (hex), first arrival first:
// { id, node, signed (the innermost verified Signed record), key (its
// signer, hex), arrival, parent (hex, for a Reply), to (its To prefix or
// null), children: [] }
export function posts(entries) {
	const byId = new Map();
	for (const e of entries) {
		for (const nodes of [e.nodes, ...(e.fragments ?? []).map((f) => f.nodes)]) {
			if (!nodes)
				continue;
			for (const [n, path] of walk(nodes)) {
				if ((n.type !== T.TOPIC && n.type !== T.REPLY) || n.dropped || !n.id)
					continue;
				if (path.some((p) => p.dropped || p.type === T.KEYED || (p.type === T.SIGNED && p.verified !== true)))
					continue;
				const signed = path.filter((p) => p.type === T.SIGNED).at(-1);
				const id = hex(n.id);
				if (!signed || byId.has(id))
					continue;
				byId.set(id, {
					id, node: n, signed, key: hex(signed.key), arrival: e.arrival,
					parent: n.type === T.REPLY ? hex(n.parent) : null,
					to: n.chain.find((p) => p.type >= T.TO_KEY) ?? null,
					children: [],
				});
			}
		}
	}
	return byId;
}

// Where a conversation's Topic goes: { kind: 'board', board } for everyone
// or a group name, { kind: 'direct' } for a key, call sign or name,
// { kind: 'group-key' } (not shown yet) and { kind: 'elsewhere' } for a
// Reply without its parent
function place(root) {
	if (root.node.type !== T.TOPIC)
		return { kind: 'elsewhere' };
	if (!root.to)
		return { kind: 'board', board: 'everyone' };
	if (root.to.type === T.TO_GROUP_NAME)
		return { kind: 'board', board: hex(root.to.handle.raw), name: root.to.handle };
	if (root.to.type === T.TO_GROUP_KEY)
		return { kind: 'group-key' };
	return { kind: 'direct' };
}

// The conversations of the entries, newest activity first. me: { keys
// (Set of hex), calls (Set of call signs), names (array of text records'
// bytes, compared byte for byte) }. Each conversation: { root, place,
// posts (all, in arrival order), last (newest arrival), participants
// (Set of keys, for direct ones), hidden (posts by others, for direct
// ones), inbox (null or why: 'key', 'call', 'name', 'mine') }.
export function conversations(entries, me = { keys: new Set(), calls: new Set(), names: [] }) {
	const all = posts(entries);
	const roots = [];
	for (const p of all.values()) {
		if (p.parent && all.has(p.parent) && p.parent !== p.id)
			all.get(p.parent).children.push(p);
		else
			roots.push(p);
	}
	const out = [];
	for (const root of roots) {
		const list = [];
		const visit = (p) => {
			list.push(p);
			p.children.sort((a, b) => a.arrival - b.arrival);
			p.children.forEach(visit);
		};
		visit(root);
		list.sort((a, b) => a.arrival - b.arrival);
		const c = { root, place: place(root), posts: list, last: list.at(-1).arrival, participants: null, hidden: new Set(), inbox: null };
		if (c.place.kind === 'direct') {
			// the author and the recipient: the To-Key, or else the first
			// other key that replies (SPEC.md, Direct conversations)
			c.participants = new Set([root.key]);
			if (root.to.type === T.TO_KEY)
				c.participants.add(hex(root.to.handle));
			else {
				const first = list.find((p) => p.key !== root.key);
				if (first)
					c.participants.add(first.key);
			}
			// a post by anyone else is hidden with everything under it
			const hide = (p) => {
				c.hidden.add(p);
				p.children.forEach(hide);
			};
			for (const p of list)
				if (!c.participants.has(p.key) && !c.hidden.has(p))
					hide(p);
		}
		c.inbox = inboxReason(c, me);
		out.push(c);
	}
	return out.sort((a, b) => b.last - a.last);
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// why a conversation is for this station, the strongest reason first
function inboxReason(c, me) {
	const to = c.root.node.type === T.TOPIC ? c.root.to : null;
	if (to?.type === T.TO_KEY && me.keys.has(hex(to.handle)))
		return 'key';
	if (c.posts.some((p) => me.keys.has(p.key)))
		return 'mine';
	if (to?.type === T.TO_CALL && me.calls.has(to.handle))
		return 'call';
	if (to?.type === T.TO_NAME && me.names.some((n) => same(n, to.handle.raw)))
		return 'name';
	return null;
}

// The boards with their conversations: 'everyone' first, then group
// names by newest activity, then 'elsewhere' if there are orphans.
// Each: { board, name, conversations, last }.
export function boards(list) {
	const byBoard = new Map([['everyone', { board: 'everyone', name: null, conversations: [], last: 0 }]]);
	const elsewhere = { board: 'elsewhere', name: null, conversations: [], last: 0 };
	for (const c of list) {
		let b = null;
		if (c.place.kind === 'board') {
			if (!byBoard.has(c.place.board))
				byBoard.set(c.place.board, { board: c.place.board, name: c.place.name, conversations: [], last: 0 });
			b = byBoard.get(c.place.board);
		} else if (c.place.kind === 'elsewhere') {
			b = elsewhere;
		}
		if (b) {
			b.conversations.push(c);
			b.last = Math.max(b.last, c.last);
		}
	}
	const [everyone, ...groups] = byBoard.values();
	groups.sort((a, b) => b.last - a.last);
	return [everyone, ...groups, ...(elsewhere.conversations.length ? [elsewhere] : [])];
}
