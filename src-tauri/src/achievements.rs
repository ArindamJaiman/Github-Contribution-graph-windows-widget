//! Achievements: milestones earned from the contribution calendar. Unlocks
//! are remembered for the main user (achievements.json) so they survive the
//! rolling one-year window; other users' achievements are computed live.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::github::ContributionDay;
use crate::race::week_start;

/// Streak records shorter than this aren't worth a notification.
const MIN_RECORD_STREAK: i64 = 3;

#[derive(Clone, Copy)]
enum Metric {
    Streak,
    Total,
    BestDay,
    ActiveDays,
    PerfectWeek,
}

struct Def {
    id: &'static str,
    icon: &'static str,
    title: &'static str,
    description: &'static str,
    unit: &'static str,
    metric: Metric,
    target: i64,
}

const fn def(
    id: &'static str,
    icon: &'static str,
    title: &'static str,
    description: &'static str,
    unit: &'static str,
    metric: Metric,
    target: i64,
) -> Def {
    Def { id, icon, title, description, unit, metric, target }
}

const DEFS: &[Def] = &[
    def("streak_7", "🔥", "Week Warrior", "Keep a 7-day streak", "days", Metric::Streak, 7),
    def("streak_30", "🔥", "Month on Fire", "Keep a 30-day streak", "days", Metric::Streak, 30),
    def("streak_100", "💯", "Centurion", "Keep a 100-day streak", "days", Metric::Streak, 100),
    def("streak_365", "👑", "Unbreakable", "Contribute every day for a whole year", "days", Metric::Streak, 365),
    def("total_100", "🌱", "Sprout", "100 contributions in a year", "contributions", Metric::Total, 100),
    def("total_500", "🌿", "Growing Strong", "500 contributions in a year", "contributions", Metric::Total, 500),
    def("total_1000", "🌳", "Thousand Club", "1,000 contributions in a year", "contributions", Metric::Total, 1000),
    def("total_2500", "🚀", "Liftoff", "2,500 contributions in a year", "contributions", Metric::Total, 2500),
    def("day_10", "⚡", "Power Day", "10 contributions in a single day", "in a day", Metric::BestDay, 10),
    def("day_25", "🌩️", "Storm", "25 contributions in a single day", "in a day", Metric::BestDay, 25),
    def("day_50", "🌋", "Eruption", "50 contributions in a single day", "in a day", Metric::BestDay, 50),
    def("active_100", "📅", "Regular", "Contribute on 100 days in a year", "active days", Metric::ActiveDays, 100),
    def("active_200", "🗓️", "Habit Formed", "Contribute on 200 days in a year", "active days", Metric::ActiveDays, 200),
    def("active_300", "🏅", "Always Shipping", "Contribute on 300 days in a year", "active days", Metric::ActiveDays, 300),
    def("perfect_week", "✨", "Perfect Week", "Contribute every day from Monday to Sunday", "days this week", Metric::PerfectWeek, 7),
];

impl Def {
    /// Value that unlocks the achievement once it reaches the target.
    fn unlock_value(&self, m: &Metrics) -> i64 {
        match self.metric {
            Metric::Streak => m.longest_streak,
            Metric::Total => m.total,
            Metric::BestDay => m.best_day,
            Metric::ActiveDays => m.active_days,
            Metric::PerfectWeek => m.best_week_active,
        }
    }

    /// Value shown as progress while locked: the streak or week in progress,
    /// rather than a past best that fell short.
    fn progress_value(&self, m: &Metrics) -> i64 {
        match self.metric {
            Metric::Streak => m.current_streak,
            Metric::PerfectWeek => m.week_active,
            _ => self.unlock_value(m),
        }
    }
}

/// Numbers achievements are judged on, from one calendar.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Metrics {
    pub current_streak: i64,
    /// First day of the current streak, if there is one.
    pub streak_start: Option<String>,
    pub longest_streak: i64,
    pub total: i64,
    pub best_day: i64,
    pub active_days: i64,
    /// Active days in the latest Monday–Sunday week, and in the best one.
    pub week_active: i64,
    pub best_week_active: i64,
}

/// Same streak rules as the rest of the app: the last calendar day is
/// "today", and a zero there doesn't break the current streak.
pub fn metrics(weeks: &[Vec<ContributionDay>]) -> Metrics {
    let mut days: Vec<&ContributionDay> = weeks.iter().flatten().collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));

    let mut m = Metrics::default();
    let mut run = 0;
    let mut week: Option<NaiveDate> = None;
    for d in &days {
        let count = d.count.max(0) as i64;
        m.total += count;
        m.best_day = m.best_day.max(count);
        if count > 0 {
            m.active_days += 1;
            run += 1;
            m.longest_streak = m.longest_streak.max(run);
        } else {
            run = 0;
        }
        if let Ok(date) = NaiveDate::parse_from_str(&d.date, "%Y-%m-%d") {
            let start = week_start(date);
            if week != Some(start) {
                week = Some(start);
                m.week_active = 0;
            }
            if count > 0 {
                m.week_active += 1;
                m.best_week_active = m.best_week_active.max(m.week_active);
            }
        }
    }

    for (i, d) in days.iter().enumerate().rev() {
        if d.count > 0 {
            m.current_streak += 1;
            m.streak_start = Some(d.date.clone());
        } else if i + 1 < days.len() {
            break;
        }
    }
    m
}

/// What the app remembers about the main user's achievements.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct AchievementLog {
    pub username: String,
    /// Achievement id → local date it was unlocked.
    pub unlocked: BTreeMap<String, String>,
    /// Longest streak ever seen (outlives the one-year window).
    pub best_streak: i64,
    /// Start date of the streak already celebrated as a personal best, so a
    /// record run is announced once rather than every day it grows.
    pub record_streak_start: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Achievement {
    pub id: &'static str,
    pub icon: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub unit: &'static str,
    pub current: i64,
    pub target: i64,
    pub unlocked: bool,
    pub unlocked_on: Option<String>,
}

/// Every achievement with its progress. Anything in `log` stays unlocked even
/// if the one-year window no longer shows it.
pub fn evaluate(m: &Metrics, log: Option<&AchievementLog>) -> Vec<Achievement> {
    DEFS.iter()
        .map(|d| {
            let unlocked_on = log.and_then(|l| l.unlocked.get(d.id).cloned());
            Achievement {
                id: d.id,
                icon: d.icon,
                title: d.title,
                description: d.description,
                unit: d.unit,
                current: d.progress_value(m),
                target: d.target,
                unlocked: unlocked_on.is_some() || d.unlock_value(m) >= d.target,
                unlocked_on,
            }
        })
        .collect()
}

/// What changed when a calendar was recorded into the log.
#[derive(Debug, Default, PartialEq)]
pub struct Progress {
    /// (title, description) of each newly unlocked achievement.
    pub unlocked: Vec<(&'static str, &'static str)>,
    /// Length of a streak that just beat the previous best.
    pub new_record: Option<i64>,
}

/// Records newly met achievements and a personal-best streak into `log`.
pub fn record(log: &mut AchievementLog, m: &Metrics, today: NaiveDate) -> Progress {
    let date = today.format("%Y-%m-%d").to_string();
    let mut progress = Progress::default();
    for d in DEFS {
        if d.unlock_value(m) >= d.target && !log.unlocked.contains_key(d.id) {
            log.unlocked.insert(d.id.to_string(), date.clone());
            progress.unlocked.push((d.title, d.description));
        }
    }
    if m.current_streak > log.best_streak
        && m.current_streak >= MIN_RECORD_STREAK
        && log.best_streak > 0
        && log.record_streak_start != m.streak_start
    {
        progress.new_record = Some(m.current_streak);
        log.record_streak_start = m.streak_start.clone();
    }
    log.best_streak = log.best_streak.max(m.longest_streak);
    progress
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, count: i32) -> ContributionDay {
        ContributionDay { date: date.into(), count, level: 1 }
    }

    /// Consecutive days starting at `start` with the given counts.
    fn run(start: &str, counts: &[i32]) -> Vec<Vec<ContributionDay>> {
        let start = NaiveDate::parse_from_str(start, "%Y-%m-%d").unwrap();
        let days = counts
            .iter()
            .enumerate()
            .map(|(i, &c)| day(&(start + chrono::Duration::days(i as i64)).format("%Y-%m-%d").to_string(), c))
            .collect();
        vec![days]
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2024, 10, 20).unwrap()
    }

    #[test]
    fn metrics_follow_the_streak_rules() {
        // Mon 2024-10-07 .. Sun 2024-10-13 all active, then a gap, then 2 days + empty today.
        let weeks = run("2024-10-07", &[1, 2, 3, 1, 1, 12, 1, 0, 4, 5, 0]);
        let m = metrics(&weeks);
        assert_eq!(m.longest_streak, 7);
        assert_eq!(m.current_streak, 2);
        assert_eq!(m.streak_start.as_deref(), Some("2024-10-15"));
        assert_eq!(m.best_day, 12);
        assert_eq!(m.active_days, 9);
        assert_eq!(m.best_week_active, 7);
        assert_eq!(m.week_active, 2);
    }

    #[test]
    fn unlocks_are_recorded_once_and_survive_the_window() {
        let m = metrics(&run("2024-10-07", &[1, 2, 3, 1, 1, 12, 1]));
        let mut log = AchievementLog::default();
        let p = record(&mut log, &m, today());
        let titles: Vec<_> = p.unlocked.iter().map(|(t, _)| *t).collect();
        assert_eq!(titles, vec!["Week Warrior", "Power Day", "Perfect Week"]);
        assert!(record(&mut log, &m, today()).unlocked.is_empty());

        // Later the streak has dropped out of the window: still unlocked.
        let later = metrics(&run("2025-01-01", &[1]));
        let items = evaluate(&later, Some(&log));
        let week_warrior = items.iter().find(|a| a.id == "streak_7").unwrap();
        assert!(week_warrior.unlocked);
        assert_eq!(week_warrior.unlocked_on.as_deref(), Some("2024-10-20"));
        assert!(!evaluate(&later, None).iter().find(|a| a.id == "streak_7").unwrap().unlocked);
    }

    #[test]
    fn a_record_streak_is_announced_once_per_run() {
        let mut log = AchievementLog { best_streak: 3, ..Default::default() };
        let four = metrics(&run("2024-10-01", &[1, 1, 1, 1]));
        assert_eq!(record(&mut log, &four, today()).new_record, Some(4));
        assert_eq!(log.best_streak, 4);
        // Same run keeps growing: no repeat announcement.
        let five = metrics(&run("2024-10-01", &[1, 1, 1, 1, 1]));
        assert_eq!(record(&mut log, &five, today()).new_record, None);
        assert_eq!(log.best_streak, 5);
        // A brand-new log (first run) never announces a record.
        let mut fresh = AchievementLog::default();
        assert_eq!(record(&mut fresh, &five, today()).new_record, None);
    }
}
