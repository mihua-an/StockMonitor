//! A replay view moved by a seek, sent as what changed: the view's whole state as last sent (`prev`) and as it is now
//! (`next`), told as a list of operations that turn the one into the other (docs/system-architecture/03 section 6).
//! The renderer applies them to the state it holds, which is `prev` exactly: Market Runtime sends them only while
//! nothing else reached the view since (see server::replay_feed).
//!
//! An operation names a path (object keys and array indices from the top) and one of:
//! * `{"set": value}`: the value there is now `value` (a new field included);
//! * `{"remove": true}`: the field is gone;
//! * `{"keep": [start, end], "prepend": [..], "append": [..]}`: the array there is `prepend`, then its elements
//!   `start..end`, then `append` -- a tape that moved on (its oldest prints dropped, new ones added) or back (its newest
//!   dropped, older ones in front), a newest-first list that grew at its head, a series that grew or was cut back.

use serde_json::{json, Value};

/// The operations that turn `prev` into `next`.
pub fn diff(prev: &Value, next: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    diff_at(prev, next, &mut Vec::new(), &mut out);
    out
}

fn diff_at(prev: &Value, next: &Value, path: &mut Vec<Value>, out: &mut Vec<Value>) {
    if prev == next {
        return;
    }
    match (prev, next) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                path.push(json!(k));
                match a.get(k) {
                    Some(old) => diff_at(old, v, path, out),
                    None => out.push(json!({"path": path, "set": v})),
                }
                path.pop();
            }
            for k in a.keys().filter(|k| !b.contains_key(*k)) {
                path.push(json!(k));
                out.push(json!({"path": path, "remove": true}));
                path.pop();
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            // A window that moved on: `prev`'s elements from some point on are `next`'s first ones.
            if let Some(s) = (1..a.len()).find(|&s| a.len() - s <= b.len() && a[s..] == b[..a.len() - s]) {
                out.push(keep(path, s, a.len(), &[], &b[a.len() - s..]));
                return;
            }
            // A window that moved back, or a list that grew at its head: `prev`'s first elements follow new ones.
            if let Some(s) = (1..b.len()).find(|&s| {
                let k = a.len().min(b.len() - s);
                k > 0 && b[s..s + k] == a[..k]
            }) {
                let k = a.len().min(b.len() - s);
                out.push(keep(path, 0, k, &b[..s], &b[s + k..]));
                return;
            }
            if a.len() == b.len() {
                for (i, (old, new)) in a.iter().zip(b).enumerate() {
                    path.push(json!(i));
                    diff_at(old, new, path, out);
                    path.pop();
                }
                return;
            }
            let common = a.iter().zip(b).take_while(|(x, y)| x == y).count();
            out.push(keep(path, 0, common, &[], &b[common..]));
        }
        _ => out.push(json!({"path": path, "set": next})),
    }
}

fn keep(path: &[Value], start: usize, end: usize, prepend: &[Value], append: &[Value]) -> Value {
    json!({"path": path, "keep": [start, end], "prepend": prepend, "append": append})
}

/// Apply `ops` (from `diff`) to `state`. An operation that does not fit `state` (a path that is not there, a range
/// past an array's end) is an error: the state was not the one the operations were made from.
pub fn apply(state: &mut Value, ops: &[Value]) -> Result<(), String> {
    for op in ops {
        let path = op["path"].as_array().ok_or("an operation without a path")?;
        let (target, last) = match path.split_last() {
            Some((last, parents)) => (walk(state, parents)?, Some(last)),
            None => (state as &mut Value, None),
        };
        if let Some(value) = op.get("set") {
            match last {
                None => *target = value.clone(),
                Some(Value::String(k)) => {
                    target.as_object_mut().ok_or_else(|| format!("{path:?}: not an object"))?.insert(k.clone(), value.clone());
                }
                Some(i) => *index(target, i, path)? = value.clone(),
            }
        } else if op.get("remove") == Some(&Value::Bool(true)) {
            let key = last.and_then(Value::as_str).ok_or_else(|| format!("{path:?}: only a field is removed"))?;
            target.as_object_mut().ok_or_else(|| format!("{path:?}: not an object"))?.remove(key).ok_or_else(|| format!("{path:?}: no such field"))?;
        } else if let (Some(keep), Some(prepend), Some(append)) = (op["keep"].as_array(), op["prepend"].as_array(), op["append"].as_array()) {
            let at = match last {
                None => target,
                Some(Value::String(k)) => target.get_mut(k.as_str()).ok_or_else(|| format!("{path:?}: no such field"))?,
                Some(i) => index(target, i, path)?,
            };
            let items = at.as_array_mut().ok_or_else(|| format!("{path:?}: not an array"))?;
            let bound = |v: &Value| v.as_u64().map(|n| n as usize).ok_or_else(|| format!("{path:?}: keep is not a range"));
            let (start, end) = (bound(&keep[0])?, bound(keep.get(1).unwrap_or(&Value::Null))?);
            if start > end || end > items.len() {
                return Err(format!("{path:?}: keep {start}..{end} of {} elements", items.len()));
            }
            items.truncate(end);
            items.splice(..start, prepend.iter().cloned());
            items.extend(append.iter().cloned());
        } else {
            return Err(format!("{path:?}: an operation that sets, removes or keeps nothing"));
        }
    }
    Ok(())
}

fn walk<'a>(mut at: &'a mut Value, path: &[Value]) -> Result<&'a mut Value, String> {
    for seg in path {
        at = match seg {
            Value::String(k) => at.get_mut(k.as_str()).ok_or_else(|| format!("{path:?}: no field {k}"))?,
            i => index(at, i, path)?,
        };
    }
    Ok(at)
}

fn index<'a>(at: &'a mut Value, i: &Value, path: &[Value]) -> Result<&'a mut Value, String> {
    let i = i.as_u64().ok_or_else(|| format!("{path:?}: a step is neither a field nor an index"))? as usize;
    at.as_array_mut().and_then(|items| items.get_mut(i)).ok_or_else(|| format!("{path:?}: no element {i}"))
}

/// The top-level fields the operations touch (the view's channels that changed).
pub fn touched(ops: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = ops.iter().filter_map(|op| op["path"].get(0).and_then(Value::as_str).map(str::to_string)).collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(n: u64) -> Value {
        json!({"durable_sequence": n, "price": 100 + n})
    }

    fn round_trip(prev: Value, next: Value) -> Vec<Value> {
        let ops = diff(&prev, &next);
        let mut held = prev.clone();
        apply(&mut held, &ops).unwrap();
        assert_eq!(held, next, "the operations turn the view held into the new one: {ops:?}");
        ops
    }

    /// The tape moved on (its oldest prints dropped, new ones added), a field changed inside a series, a field added and
    /// one gone: each is told as what changed, and applied it is exactly the new view.
    #[test]
    fn what_changed_turns_the_view_held_into_the_new_one() {
        let tape = |from: u64, to: u64| Value::Array((from..to).map(trade).collect());
        let prev = json!({"trades": tape(0, 100), "trend": [{"m": 1, "c": 1}, {"m": 2, "c": 2}], "summary": {"price": 1, "old": true}, "same": [1, 2]});
        let next = json!({"trades": tape(3, 103), "trend": [{"m": 1, "c": 1}, {"m": 2, "c": 5}], "summary": {"price": 2, "new": 1}, "same": [1, 2]});
        let ops = round_trip(prev, next);
        assert!(ops.contains(&json!({"path": ["trades"], "keep": [3, 100], "prepend": [], "append": [trade(100), trade(101), trade(102)]})), "{ops:?}");
        assert!(ops.contains(&json!({"path": ["trend", 1, "c"], "set": 5})), "one field of one minute: {ops:?}");
        assert!(ops.contains(&json!({"path": ["summary", "old"], "remove": true})));
        assert_eq!(touched(&ops), vec!["summary", "trades", "trend"], "the channels that changed, `same` not among them");
        // A seek back: the tape moved back (its newest prints dropped, older ones in front), a series cut shorter.
        let ops = round_trip(json!({"trades": tape(3, 103), "trend": [1, 2, 3]}), json!({"trades": tape(0, 100), "trend": [1, 2]}));
        assert!(ops.contains(&json!({"path": ["trades"], "keep": [0, 97], "prepend": [trade(0), trade(1), trade(2)], "append": []})), "{ops:?}");
        round_trip(json!({"trades": tape(3, 103)}), json!({"trades": tape(0, 50)}));
        // A newest-first list that grew at its head (大單 列表): the new rows only.
        let newest_first = |from: u64, to: u64| Value::Array((from..to).rev().map(trade).collect());
        let ops = round_trip(json!({"large": newest_first(0, 40)}), json!({"large": newest_first(0, 42)}));
        assert_eq!(ops, vec![json!({"path": ["large"], "keep": [0, 40], "prepend": [trade(41), trade(40)], "append": []})]);
        // A seek forward past the whole tape: nothing kept.
        round_trip(json!({"trades": tape(0, 10)}), json!({"trades": tape(500, 510)}));
        round_trip(json!({"trades": []}), json!({"trades": tape(0, 5), "x": null}));
        assert!(diff(&json!({"a": [1]}), &json!({"a": [1]})).is_empty());
    }

    /// Operations made from another view than the one held do not apply: the client asks for the view whole.
    #[test]
    fn operations_that_do_not_fit_the_view_held_are_refused() {
        let ops = diff(&json!({"trades": [trade(1), trade(2), trade(3)], "s": {"a": 1}}), &json!({"trades": [trade(2), trade(3), trade(4)], "s": {}}));
        assert!(apply(&mut json!({"trades": [trade(1)], "s": {"a": 1}}), &ops).is_err(), "a tape shorter than the range kept");
        assert!(apply(&mut json!({"trades": [], "s": {}}), &ops).is_err(), "a field to remove that is not there");
        assert!(apply(&mut json!({}), &[json!({"path": ["x", "y"], "set": 1})]).is_err(), "a path that is not there");
        assert!(apply(&mut json!({"a": 1}), &[json!({"path": ["a"]})]).is_err(), "an operation that does nothing");
    }
}
