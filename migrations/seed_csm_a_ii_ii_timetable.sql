-- Real timetable for Doodam Yogi Jatin Sai
-- Department of CSE (AIML), Academic Year 2026-2027
-- Class CSM-A, Room 304, Year/Sem II/II, w.e.f 29-07-2026, Regulation R25
-- Class coordinator: Mrs. Suneetha. Overall coordinator: Mrs. C. Archana.
--
-- The previous rows (Computer Science 101 / Data Structures / Algorithms /
-- Database Systems) were placeholder seed data. They are deactivated, not deleted.

UPDATE timetable_semesters SET is_active = 0, updated_at = datetime('now');

INSERT OR REPLACE INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
VALUES ('sem_csm_a_2026_ii_ii', 'B.Tech II/II - CSM-A (2026-2027)', '2026-07-29', '2026-12-31', 1, datetime('now'), datetime('now'));

UPDATE timetable_slots SET active = 0, updated_at = datetime('now') WHERE semester_id != 'sem_csm_a_2026_ii_ii';

INSERT OR REPLACE INTO timetable_subjects (id, semester_id, code, name, faculty, default_room, section_name, created_at, updated_at) VALUES
  ('subj_java',     'sem_csm_a_2026_ii_ii', '25CS303PC', 'OOP through Java',                        'Dr. A. Anil Kumar Reddy', '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_javalab',  'sem_csm_a_2026_ii_ii', '25CS307PC', 'OOP through Java Lab',                    'Mr. P. Venkatesh',        '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_se',       'sem_csm_a_2026_ii_ii', '25CS304PC', 'Software Engineering',                    'Mrs. Suneetha',           '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_selab',    'sem_csm_a_2026_ii_ii', '25CS308PC', 'Software Engineering Lab',                'Mrs. C. Archana',         '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_coa',      'sem_csm_a_2026_ii_ii', '25CS302PC', 'Computer Organization and Architecture',  'Mrs. C. Archana',         '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_dbms',     'sem_csm_a_2026_ii_ii', '25CS305PC', 'Database Management System',              'Mrs. V. Swapna Teja',     '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_dbmslab',  'sem_csm_a_2026_ii_ii', '25CS309PC', 'Database Management Systems Lab',         'Mrs. D. Aparna',          '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_msf',      'sem_csm_a_2026_ii_ii', '25MA401BS', 'Mathematical and Statistical Foundations', 'Mrs. M. Mounika',         '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_cmlab',    'sem_csm_a_2026_ii_ii', '25MA306PC', 'Computational Mathematics Lab',           'Mrs. M. Mounika',         '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_react',    'sem_csm_a_2026_ii_ii', '25CS310SD', 'Node JS / React JS / Django',             'Mrs. V. Swapna Teja',     '304', 'CSM-A', datetime('now'), datetime('now')),
  ('subj_si',       'sem_csm_a_2026_ii_ii', NULL,       'SI (name not yet confirmed)',              NULL,                      '304', 'CSM-A', datetime('now'), datetime('now'));

-- Monday (weekday 1)
INSERT OR REPLACE INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, active, created_at, updated_at) VALUES
  ('slot_mon_javalab', 'sem_csm_a_2026_ii_ii', 'subj_javalab', 1, '09:15', '11:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_mon_se',      'sem_csm_a_2026_ii_ii', 'subj_se',      1, '11:15', '12:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_mon_coa',     'sem_csm_a_2026_ii_ii', 'subj_coa',     1, '12:15', '13:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_mon_dbmslab', 'sem_csm_a_2026_ii_ii', 'subj_dbmslab', 1, '14:00', '17:15', '304', 1, datetime('now'), datetime('now'));

-- Tuesday (weekday 2)
INSERT OR REPLACE INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, active, created_at, updated_at) VALUES
  ('slot_tue_se',    'sem_csm_a_2026_ii_ii', 'subj_se',   2, '09:15', '10:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_tue_dbms',  'sem_csm_a_2026_ii_ii', 'subj_dbms', 2, '10:15', '11:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_tue_java1', 'sem_csm_a_2026_ii_ii', 'subj_java', 2, '11:15', '12:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_tue_java2', 'sem_csm_a_2026_ii_ii', 'subj_java', 2, '12:15', '13:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_tue_cmlab', 'sem_csm_a_2026_ii_ii', 'subj_cmlab', 2, '14:00', '17:15', '304', 1, datetime('now'), datetime('now'));

-- Wednesday (weekday 3)
INSERT OR REPLACE INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, active, created_at, updated_at) VALUES
  ('slot_wed_java',   'sem_csm_a_2026_ii_ii', 'subj_java', 3, '09:15', '11:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_wed_dbms',   'sem_csm_a_2026_ii_ii', 'subj_dbms', 3, '11:15', '12:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_wed_msf',    'sem_csm_a_2026_ii_ii', 'subj_msf',  3, '12:15', '13:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_wed_dbmst',  'sem_csm_a_2026_ii_ii', 'subj_dbms', 3, '14:00', '15:00', '304', 1, datetime('now'), datetime('now')),
  ('slot_wed_coa',    'sem_csm_a_2026_ii_ii', 'subj_coa',  3, '15:00', '16:00', '304', 1, datetime('now'), datetime('now'));

-- Thursday (weekday 4)
INSERT OR REPLACE INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, active, created_at, updated_at) VALUES
  ('slot_thu_selab', 'sem_csm_a_2026_ii_ii', 'subj_selab', 4, '09:15', '11:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_thu_se',    'sem_csm_a_2026_ii_ii', 'subj_se',    4, '11:15', '12:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_thu_coa',   'sem_csm_a_2026_ii_ii', 'subj_coa',   4, '12:15', '13:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_thu_msf',   'sem_csm_a_2026_ii_ii', 'subj_msf',   4, '14:00', '15:00', '304', 1, datetime('now'), datetime('now')),
  ('slot_thu_si',    'sem_csm_a_2026_ii_ii', 'subj_si',    4, '15:00', '16:00', '304', 1, datetime('now'), datetime('now'));

-- Friday (weekday 5)
INSERT OR REPLACE INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, active, created_at, updated_at) VALUES
  ('slot_fri_dbms',  'sem_csm_a_2026_ii_ii', 'subj_dbms', 5, '09:15', '10:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_fri_javat', 'sem_csm_a_2026_ii_ii', 'subj_java', 5, '10:15', '11:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_fri_msf1',  'sem_csm_a_2026_ii_ii', 'subj_msf',  5, '11:15', '12:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_fri_msf2',  'sem_csm_a_2026_ii_ii', 'subj_msf',  5, '14:00', '15:00', '304', 1, datetime('now'), datetime('now'));

-- Saturday (weekday 6)
INSERT OR REPLACE INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, active, created_at, updated_at) VALUES
  ('slot_sat_coa',    'sem_csm_a_2026_ii_ii', 'subj_coa',   6, '09:15', '10:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_sat_dbms',   'sem_csm_a_2026_ii_ii', 'subj_dbms',  6, '10:15', '11:15', '304', 1, datetime('now'), datetime('now')),
  ('slot_sat_react',  'sem_csm_a_2026_ii_ii', 'subj_react', 6, '11:15', '13:15', '304', 1, datetime('now'), datetime('now'));
