-- Owner-confirmed profile facts (added 2026-11-13 after he asked for them in permanent memory).
INSERT OR IGNORE INTO memory_objects (id, type, title, canonical_text, source, trust, sensitivity, tags, created_at, updated_at) VALUES
  ('mem_owner_academic_2026', 'fact',
   'Owner is in II B.Tech CSE (AI & ML), class CSM-A, room 304',
   'Owner is in II B.Tech, second semester, CSE (AI & ML). Class CSM-A, room 304, academic year 2026-2027, regulation R25.',
   'owner:telegram', 'high', 'normal', 'academic,college', datetime('now'), datetime('now')),
  ('mem_owner_timetable_2026', 'fact',
   'Owner timetable: CSM-A II/II from 29-07-2026',
   'Owner timetable (CSM-A, II/II, effective 29-07-2026): OOP through Java (25CS303PC), Software Engineering (25CS304PC), Computer Organization and Architecture (25CS302PC), Database Management System (25CS305PC), Mathematical and Statistical Foundations (25MA401BS), and labs: Java Lab, SE Lab, DBMS Lab, Computational Mathematics Lab, Node/React/Django.',
   'owner:telegram', 'high', 'normal', 'academic,timetable', datetime('now'), datetime('now')),
  ('mem_owner_coordinators_2026', 'fact',
   'Class coordinator Mrs. Suneetha; overall coordinator Mrs. C. Archana',
   'Class coordinator for CSM-A is Mrs. Suneetha. Overall coordinator is Mrs. C. Archana.',
   'owner:telegram', 'high', 'normal', 'academic', datetime('now'), datetime('now'));
