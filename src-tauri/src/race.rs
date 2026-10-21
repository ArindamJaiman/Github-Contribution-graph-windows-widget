//! Weekly race: this week's (Monday–Sunday) totals for you and the friends
//! you compare against, and detection of who passed whom between checks.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Duration, NaiveDate};

use crate::github::ContributionDay;
use crate::storage::AppConfig;

/// The leaderboard shows 12 people: you plus up to 11 friends.
const MAX_FIELD: usize = 11;

/// Friends in the race: open versus windows first, then recent history.
pub fn field(cfg: &AppConfig) -> Vec<String> {
    let mut seen = HashSet::new();
    cfg.open_versus
        .iter()
        .chain(cfg.versus_history.iter())
        .filter(|u| !cfg.is_main_user(u) && seen.insert(u.to_lowercase()))
        .take(MAX_FIELD)
        .cloned()
        .collect()
}

/// Monday of the week containing `day`.
pub fn week_start(day: NaiveDate) -> NaiveDate {
    day - Duration::days(day.weekday().num_days_from_monday() as i64)
}

/// Contributions from `start` (a Monday) through the following Sunday.
pub fn week_total(weeks: &[Vec<ContributionDay>], start: NaiveDate) -> i64 {
    let from = start.format("%Y-%m-%d").to_string();
    let to = (start + Duration::days(6)).format("%Y-%m-%d").to_string();
    weeks
        .iter()
        .flatten()
        .filter(|d| d.date >= from && d.date <= to)
        .map(|d| d.count.max(0) as i64)
        .sum()
}

pub struct Standing {
    pub name: String,
    pub total: i64,
}

#[derive(Default)]
pub struct RaceState {
    week: Option<NaiveDate>,
    user: String,
    /// Last strict ordering (you vs. them) per friend. Ties keep the previous
    /// value, so catching up and then pulling ahead still counts as a pass.
    leads: HashMap<String, Ordering>,
}

#[derive(Debug, PartialEq)]
pub enum RaceEvent {
    PassedBy(String, i64),
    Passed(String, i64),
}

/// Records the current standings and returns lead changes since the last
/// call. The first standing seen for a friend each week is only a baseline.
pub fn update(state: &mut RaceState, user: &str, week: NaiveDate, me: i64, field: &[Standing]) -> Vec<RaceEvent> {
    if state.week != Some(week) || !state.user.eq_ignore_ascii_case(user) {
        *state = RaceState { week: Some(week), user: user.to_string(), leads: HashMap::new() };
    }
    let mut events = Vec::new();
    for s in field {
        let now = me.cmp(&s.total);
        if now == Ordering::Equal {
            continue;
        }
        match state.leads.insert(s.name.to_lowercase(), now) {
            Some(before) if before != now => events.push(if now == Ordering::Less {
                RaceEvent::PassedBy(s.name.clone(), s.total)
            } else {
                RaceEvent::Passed(s.name.clone(), s.total)
            }),
            _ => {}
        }
    }
    events
}

/// 1-based place: one plus everyone strictly ahead.
pub fn rank(me: i64, field: &[Standing]) -> usize {
    1 + field.iter().filter(|s| s.total > me).count()
}

fn join_names(list: &[(&String, i64)]) -> String {
    list.iter().map(|(name, total)| format!("{} ({})", name, total)).collect::<Vec<_>>().join(", ")
}

/// Notification (title, body) pairs for a batch of events.
pub fn messages(events: &[RaceEvent], me: i64, field: &[Standing]) -> Vec<(String, String)> {
    let place = match rank(me, field) {
        1 => "You're leading the week! 🥇".to_string(),
        r => format!("You're #{} of {}.", r, field.len() + 1),
    };
    let passed_by: Vec<(&String, i64)> = events
        .iter()
        .filter_map(|e| match e {
            RaceEvent::PassedBy(name, total) => Some((name, *total)),
            _ => None,
        })
        .collect();
    let passed: Vec<(&String, i64)> = events
        .iter()
        .filter_map(|e| match e {
            RaceEvent::Passed(name, total) => Some((name, *total)),
            _ => None,
        })
        .collect();

    let mut out = Vec::new();
    match passed_by.as_slice() {
        [] => {}
        [(name, total)] => out.push((
            format!("🏁 {} passed you this week", name),
            format!("{} has {} · you have {}. {}", name, total, me, place),
        )),
        many => out.push((
            format!("🏁 {} friends passed you this week", many.len()),
            format!("{}. You have {}. {}", join_names(many), me, place),
        )),
    }
    match passed.as_slice() {
        [] => {}
        [(name, total)] => out.push((
            format!("🏁 You passed {}!", name),
            format!("You have {} · {} has {}. {}", me, name, total, place),
        )),
        many => out.push((
            format!("🏁 You passed {} friends!", many.len()),
            format!("{}. You have {}. {}", join_names(many), me, place),
        )),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn standing(name: &str, total: i64) -> Standing {
        Standing { name: name.into(), total }
    }

    #[test]
    fn weeks_start_on_monday() {
        assert_eq!(week_start(date("2024-10-09")), date("2024-10-07")); // Wed
        assert_eq!(week_start(date("2024-10-07")), date("2024-10-07")); // Mon
        assert_eq!(week_start(date("2024-10-13")), date("2024-10-07")); // Sun
    }

    #[test]
    fn week_total_counts_monday_through_sunday() {
        let day = |d: &str, count| ContributionDay { date: d.into(), count, level: 1 };
        let weeks = vec![
            vec![day("2024-10-06", 5), day("2024-10-07", 1), day("2024-10-08", 2)],
            vec![day("2024-10-13", 3), day("2024-10-14", 9)],
        ];
        assert_eq!(week_total(&weeks, date("2024-10-07")), 6);
    }

    #[test]
    fn lead_changes_become_events_and_ties_keep_the_old_lead() {
        let week = date("2024-10-07");
        let mut state = RaceState::default();

        // First sighting is a baseline.
        assert!(update(&mut state, "me", week, 5, &[standing("ana", 3)]).is_empty());
        // Ana catches up (tie), then pulls ahead.
        assert!(update(&mut state, "me", week, 5, &[standing("ana", 5)]).is_empty());
        assert_eq!(
            update(&mut state, "me", week, 5, &[standing("ana", 7)]),
            vec![RaceEvent::PassedBy("ana".into(), 7)]
        );
        // I take it back.
        assert_eq!(
            update(&mut state, "me", week, 8, &[standing("ana", 7)]),
            vec![RaceEvent::Passed("ana".into(), 7)]
        );
        // A new week starts from scratch.
        assert!(update(&mut state, "me", date("2024-10-14"), 0, &[standing("ana", 2)]).is_empty());
    }

    #[test]
    fn messages_name_the_friend_and_your_place() {
        let field = [standing("ana", 7), standing("bo", 2)];
        let msgs = messages(&[RaceEvent::PassedBy("ana".into(), 7)], 5, &field);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].0, "🏁 ana passed you this week");
        assert!(msgs[0].1.ends_with("You're #2 of 3."));

        let msgs = messages(&[RaceEvent::Passed("ana".into(), 7)], 9, &field);
        assert_eq!(msgs[0].0, "🏁 You passed ana!");
        assert!(msgs[0].1.contains("leading the week"));
    }

    #[test]
    fn field_skips_you_and_duplicates() {
        let cfg = AppConfig {
            username: "Me".into(),
            open_versus: vec!["ana".into()],
            versus_history: vec!["Ana".into(), "me".into(), "bo".into()],
            ..AppConfig::default()
        };
        assert_eq!(field(&cfg), vec!["ana".to_string(), "bo".to_string()]);
    }
}
