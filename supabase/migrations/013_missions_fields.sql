-- ChurchOS v2 — Migration 013: Mission & Evangelism fields

alter table missions
  add column if not exists coordinating_group text,
  add column if not exists participants       integer,
  add column if not exists persons_reached     integer,
  add column if not exists souls_won           integer;
