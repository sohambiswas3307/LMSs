CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    phone VARCHAR(20),
    age INT,
    role VARCHAR(20) NOT NULL,  -- Student or Teacher
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE courses (
    id SERIAL PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    duration VARCHAR(50),
    teacher_id INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
SELECT * from courses;
CREATE TABLE enrollments (
    id SERIAL PRIMARY KEY,
    student_id INT REFERENCES users(id),
    course_id INT REFERENCES courses(id),
    enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, course_id)  -- prevents duplicate enrollment in same course
);
SELECT * from enrollments;
CREATE TABLE assignments (
    id SERIAL PRIMARY KEY,
    course_id INT REFERENCES courses(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    due_date DATE,
    file_path VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE submissions (
    id SERIAL PRIMARY KEY,
    assignment_id INT REFERENCES assignments(id) ON DELETE CASCADE,
    student_id INT REFERENCES users(id) ON DELETE CASCADE,
    file_path VARCHAR(255),
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

SELECT * from assignments;

ALTER TABLE assignments
ADD COLUMN points INT DEFAULT 0;

ALTER TABLE submissions
ADD COLUMN grade INT;

ALTER TABLE submissions
ADD COLUMN feedback TEXT;


-- Quizzes table
CREATE TABLE quizzes (
    id SERIAL PRIMARY KEY,
    course_id INT REFERENCES courses(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    total_points INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Quiz questions table
CREATE TABLE quiz_questions (
    id SERIAL PRIMARY KEY,
    quiz_id INT REFERENCES quizzes(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT NOT NULL,
    option_d TEXT NOT NULL,
    correct_option CHAR(1) NOT NULL
);

SELECT * from quiz_questions;

-- Quiz submissions per student
CREATE TABLE quiz_submissions (
    id SERIAL PRIMARY KEY,
    quiz_id INT REFERENCES quizzes(id) ON DELETE CASCADE,
    student_id INT REFERENCES users(id) ON DELETE CASCADE,
    score INT,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_quiz_student UNIQUE(quiz_id, student_id)  -- required for ON CONFLICT
);


-- Total score per student per course
CREATE TABLE student_quiz_totals (
    id SERIAL PRIMARY KEY,
    student_id INT REFERENCES users(id) ON DELETE CASCADE,
    course_id INT REFERENCES courses(id) ON DELETE CASCADE,
    total_score INT DEFAULT 0,
    CONSTRAINT unique_student_course UNIQUE(student_id, course_id)  -- required for ON CONFLICT
);

-- Total score across all courses
CREATE TABLE student_total_score (
    student_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_score INT DEFAULT 0
);

SELECT * from student_total_score;
ALTER TABLE quiz_submissions
ALTER COLUMN score TYPE NUMERIC;

SELECT * from quizzes;
SELECT * from quiz_submissions;
SELECT * from quiz_questions;

ALTER TABLE quiz_submissions
ADD COLUMN time_taken INT DEFAULT 0;

ALTER TABLE quiz_submissions
ADD COLUMN IF NOT EXISTS time_taken INT DEFAULT 0;
ALTER TABLE quiz_submissions ADD COLUMN started_at TIMESTAMP;

ALTER TABLE student_total_score
ADD COLUMN exp_total INT DEFAULT 0;

ALTER TABLE student_quiz_totals
ALTER COLUMN total_score TYPE NUMERIC;

ALTER TABLE student_total_score
ALTER COLUMN total_score TYPE NUMERIC;


ALTER TABLE student_total_score
ADD CONSTRAINT student_unique UNIQUE (student_id);

CREATE TABLE course_materials (
  id SERIAL PRIMARY KEY,
  course_id INT REFERENCES courses(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  uploaded_at TIMESTAMP DEFAULT NOW()
);

SELECT * from course_materials;


CREATE TABLE course_forum (
  id SERIAL PRIMARY KEY,
  course_id INT REFERENCES courses(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE course_forum ADD COLUMN parent_id INT REFERENCES course_forum(id) ON DELETE CASCADE;

-- Chapters per course
CREATE TABLE chapters (
    id SERIAL PRIMARY KEY,
    course_id INT REFERENCES courses(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Topics per chapter
CREATE TABLE topics (
    id SERIAL PRIMARY KEY,
    chapter_id INT REFERENCES chapters(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Videos per topic
CREATE TABLE videos (
    id SERIAL PRIMARY KEY,
    topic_id INT REFERENCES topics(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    file_path VARCHAR(255) NOT NULL,
    uploaded_at TIMESTAMP DEFAULT NOW()
);

SELECT * from chapters;
SELECT * from courses;
SELECT * from topics;
SELECT * from videos;
SELECT * from course_forum;

SELECT * from quizzes;



-- Insert quizzes for course_id = 2
INSERT INTO quizzes (course_id, title, description, total_points)
VALUES
(2, 'Intro to Programming Quiz', 'A basic quiz on programming fundamentals.', 10),
(2, 'Data Structures Quiz', 'Test your knowledge on arrays, lists, and trees.', 15),
(2, 'Algorithms Quiz', 'Assess your understanding of sorting and searching algorithms.', 20);

-- Insert questions for the first quiz (assume its id = 1)
INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option)
VALUES
(1, 'What does "HTML" stand for?', 'Hyper Text Markup Language', 'Home Tool Markup Language', 'Hyperlinks and Text Markup Language', 'Hyperlinking Text Marking Language', 'A'),
(1, 'Which tag is used for a paragraph in HTML?', '<p>', '<div>', '<span>', '<para>', 'A'),
(1, 'HTML files are saved with which extension?', '.htm', '.html', '.txt', '.doc', 'B');

-- Insert questions for the second quiz (assume id = 2)
INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option)
VALUES
(2, 'Which data structure uses LIFO?', 'Queue', 'Stack', 'Array', 'Linked List', 'B'),
(2, 'Which data structure is best for FIFO operations?', 'Stack', 'Queue', 'Tree', 'Graph', 'B'),
(2, 'Which of these is NOT a linear data structure?', 'Array', 'Linked List', 'Tree', 'Queue', 'C');

-- Insert questions for the third quiz (assume id = 3)
INSERT INTO quiz_questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option)
VALUES
(3, 'What is the time complexity of binary search?', 'O(n)', 'O(log n)', 'O(n log n)', 'O(1)', 'B'),
(3, 'Which algorithm is used to sort in ascending order?', 'Merge Sort', 'DFS', 'BFS', 'Dijkstra', 'A'),
(3, 'Which algorithm finds shortest paths in weighted graphs?', 'DFS', 'BFS', 'Dijkstra', 'Prim', 'C');

