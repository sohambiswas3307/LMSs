require('dotenv').config(); 
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const OpenAI = require("openai");

const app = express();

const uploadPath = path.join(process.cwd(), "uploads");
// Ensure uploads folder exists
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

// Middleware
app.use(express.urlencoded({ extended: true })); // parses POST data
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
console.log('Session secret:', process.env.SESSION_SECRET);
app.use(session({
  secret: process.env.SESSION_SECRET, // must NOT be undefined
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true }
}));



const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });
app.use('/uploads', express.static(uploadPath));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));







// Routes
app.get('/', (req, res) => {
  res.render('index', { user: req.session.user });
});

// Register
app.get('/register', (req, res) => {
  res.render('register', { message: '' });
});

app.post('/register', async (req, res) => {
  const { username, full_name, email, phone, age, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    await pool.query(
      "INSERT INTO users (username, full_name, email, phone, age, password, role) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [username, full_name, email, phone, age, hashedPassword, role]
    );
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { message: 'User already exists or invalid input' });
  }
});


// Login
app.get('/login', (req, res) => {
  res.render('login', { message: '' });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const isMatch = await bcrypt.compare(password, user.password);
      if (isMatch) {
        req.session.user = {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          email: user.email,
          role: user.role
        };
        return res.redirect('/home'); // redirect to role-based homepage
      }
    }
    res.render('login', { message: 'Invalid email or password' });
  } catch (err) {
    console.error(err);
    res.render('login', { message: 'Something went wrong' });
  }
});


app.get('/home', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const user = req.session.user;

  if (user.role === 'Teacher') {
    // Teacher dashboard
    try {
      const coursesResult = await pool.query(
        "SELECT * FROM courses WHERE teacher_id = $1 ORDER BY created_at DESC",
        [user.id]
      );
      const courses = coursesResult.rows;

      const coursesWithStudents = [];
      for (let course of courses) {
        const enrolledResult = await pool.query(
          `SELECT u.id, u.full_name, u.email 
           FROM enrollments e
           JOIN users u ON e.student_id = u.id
           WHERE e.course_id = $1`,
          [course.id]
        );
        coursesWithStudents.push({
          ...course,
          students: enrolledResult.rows
        });
      }

      res.render('home_teacher', { user, coursesWithStudents, message: '' });
    } catch (err) {
      console.error(err);
      res.send("Error loading teacher dashboard");
    }

  } else {
    // Student dashboard
    try {
      // Fetch all courses (for displaying available courses)
      const coursesResult = await pool.query("SELECT * FROM courses ORDER BY created_at DESC");
      const courses = coursesResult.rows;

      // Fetch enrolled courses
      const enrolledResult = await pool.query(
        `SELECT c.id, c.title, c.description, c.duration 
         FROM courses c
         JOIN enrollments e ON c.id = e.course_id
         WHERE e.student_id = $1
         ORDER BY c.created_at DESC`,
        [user.id]
      );

      const enrolledCourses = enrolledResult.rows;
      const enrolledCourseIds = enrolledCourses.map(course => course.id);

      // Calculate total grades per course
      for (let course of enrolledCourses) {
        // Fetch assignments with points
        const assignmentsResult = await pool.query(
          'SELECT id, points FROM assignments WHERE course_id=$1',
          [course.id]
        );
        const assignments = assignmentsResult.rows;

        // Fetch all submissions of this student for this course
        const submissionResult = await pool.query(
          `SELECT a.id AS assignment_id, s.grade 
           FROM assignments a
           LEFT JOIN submissions s
           ON a.id = s.assignment_id AND s.student_id=$1
           WHERE a.course_id=$2`,
          [user.id, course.id]
        );

        let totalGrade = 0;
        let totalMaxPoints = 0;

        for (let a of assignments) {
          totalMaxPoints += a.points;
          const submission = submissionResult.rows.find(sub => sub.assignment_id === a.id);
          if (submission && submission.grade != null) {
            totalGrade += submission.grade;
          }
        }

        course.totalGrade = totalGrade;
        course.totalMaxPoints = totalMaxPoints;
      }

      res.render('home_student', { user, courses, enrolledCourseIds, enrolledCourses });
    } catch (err) {
      console.error(err);
      res.send("Error loading courses");
    }
  }
});




app.post('/create-course', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Teacher') return res.redirect('/login');

  const { title, description, duration } = req.body;
  const teacher_id = req.session.user.id;

  try {
    await pool.query(
      "INSERT INTO courses (title, description, duration, teacher_id) VALUES ($1, $2, $3, $4)",
      [title, description, duration, teacher_id]
    );
    res.redirect('/home'); // back to teacher homepage
  } catch (err) {
    console.error(err);
    res.render('home_teacher', { user: req.session.user, message: 'Error creating course' });
  }
});



//Assignments
app.get('/course/:id/assignments', async (req, res) => {
  const { id } = req.params;
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  try {
    // 1️⃣ Fetch the course
    const courseResult = await pool.query('SELECT * FROM courses WHERE id=$1', [id]);
    const course = courseResult.rows[0];

    // 2️⃣ Fetch all assignments for this course
    const assignmentsResult = await pool.query(
      'SELECT * FROM assignments WHERE course_id=$1 ORDER BY created_at DESC',
      [id]
    );
    const assignments = assignmentsResult.rows;

    // 3️⃣ Attach submissions to each assignment
    for (let a of assignments) {
      const submissionsResult = await pool.query(
        'SELECT * FROM submissions WHERE assignment_id=$1',
        [a.id]
      );
      a.submissions = submissionsResult.rows; // now each assignment has its submissions
    }

    // 4️⃣ Render page
    res.render('assignment_page', {
      course,
      assignments,
      role: user.role,
      userId: user.id,
      user // needed to check student submissions
    });

  } catch (err) {
    console.error(err);
    res.send('Error loading assignments');
  }
});





// Teacher creates an assignment
app.post('/course/:id/assignments/create', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { title, description, due_date, points } = req.body;

  const marks = parseInt(points);
  if (isNaN(marks) || marks < 0 || marks > 100) {
    return res.send('Points must be between 0 and 100');
  }

  const file_path = req.file ? req.file.filename : null;

  await pool.query(
    'INSERT INTO assignments (course_id, title, description, due_date, file_path, points) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, title, description, due_date, file_path, marks]
  );

  res.redirect(`/course/${id}/assignments`);
});



// Submit assignment (student)
app.post('/assignments/:assignmentId/submit', upload.single('file'), async (req, res) => {
  const assignmentId = req.params.assignmentId;
  const studentId = req.session.user.id;
  const file_path = req.file ? req.file.filename : null;

  try {
    // Check if student already submitted
    const existing = await pool.query(
      'SELECT * FROM submissions WHERE assignment_id=$1 AND student_id=$2',
      [assignmentId, studentId]
    );

    if (existing.rows.length > 0) {
      // Optional: overwrite or prevent duplicate
      await pool.query(
        'UPDATE submissions SET file_path=$1, submitted_at=NOW() WHERE assignment_id=$2 AND student_id=$3',
        [file_path, assignmentId, studentId]
      );
    } else {
      await pool.query(
        'INSERT INTO submissions (assignment_id, student_id, file_path) VALUES ($1, $2, $3)',
        [assignmentId, studentId, file_path]
      );
    }

    res.redirect(`/course/${req.body.courseId}/assignments`);
  } catch (err) {
    console.error(err);
    res.send('Error submitting assignment');
  }
});

// Route for teachers to see all submissions of an assignment
app.get('/course/:courseId/assignments/:assignmentId/submissions', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Teacher') return res.redirect('/login');

  const { courseId, assignmentId } = req.params;

  try {
    // Fetch assignment details
    const assignmentResult = await pool.query(
      'SELECT * FROM assignments WHERE id=$1 AND course_id=$2',
      [assignmentId, courseId]
    );
    const assignment = assignmentResult.rows[0];

    // Fetch all submissions with student info
    const submissionsResult = await pool.query(`
      SELECT s.*, u.full_name AS student_name, u.email
      FROM submissions s
      JOIN users u ON s.student_id = u.id
      WHERE s.assignment_id=$1
    `, [assignmentId]);

    res.render('submissions_page', {
      assignment,
      submissions: submissionsResult.rows,
      courseId
    });

  } catch (err) {
    console.error(err);
    res.send('Error fetching submissions');
  }
});


// Save grade & feedback (teacher submits form)
app.post('/assignments/:assignmentId/submissions/:submissionId/grade', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Teacher') return res.redirect('/login');

  const { assignmentId, submissionId } = req.params;
  const { grade, feedback } = req.body;

  try {
    // Validate grade range
    const assignmentResult = await pool.query('SELECT points, course_id FROM assignments WHERE id=$1', [assignmentId]);
    const maxPoints = assignmentResult.rows[0].points;
    const gradeInt = parseInt(grade);

    if (isNaN(gradeInt) || gradeInt < 0 || gradeInt > maxPoints) {
      return res.send(`Grade must be between 0 and ${maxPoints}`);
    }

    // Update submission
    await pool.query(
      'UPDATE submissions SET grade=$1, feedback=$2 WHERE id=$3',
      [gradeInt, feedback, submissionId]
    );

    res.redirect(`/course/${assignmentResult.rows[0].course_id}/assignments/${assignmentId}/submissions`);
  } catch (err) {
    console.error(err);
    res.send('Error saving grade');
  }
});

// GET course forum with threaded replies
app.get('/course/:id/forum', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const courseId = req.params.id;
  const user = req.session.user;

  try {
    // Fetch all posts, including parent content for "replying to"
    const forumRes = await pool.query(`
      SELECT f.*, u.full_name,
        (SELECT content FROM course_forum WHERE id = f.parent_id) AS reply_to_content
      FROM course_forum f
      JOIN users u ON u.id = f.user_id
      WHERE f.course_id = $1
      ORDER BY f.created_at ASC
    `, [courseId]);

    const posts = forumRes.rows;

    // Build threaded structure
    const map = {};
    const tree = [];

    posts.forEach(p => {
      p.replies = [];
      map[p.id] = p;
    });

    posts.forEach(p => {
      if (p.parent_id) {
        // Only attach if parent exists
        if (map[p.parent_id]) {
          map[p.parent_id].replies.push(p);
        } else {
          tree.push(p); // fallback if parent missing
        }
      } else {
        tree.push(p);
      }
    });

    res.render('course_forum', { user, courseId, posts: tree });

  } catch (err) {
    console.error(err);
    res.send("Error loading forum");
  }
});


// POST a new forum post or reply
app.post('/course/:id/forum', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const courseId = req.params.id;
  const userId = req.session.user.id;
  const { content, parent_id } = req.body; // optional parent_id

  if (!content || content.trim() === '') return res.send('Cannot post empty content');

  try {
    await pool.query(
      'INSERT INTO course_forum (course_id, user_id, content, parent_id) VALUES ($1, $2, $3, $4)',
      [courseId, userId, content, parent_id || null]
    );
    res.redirect(`/course/${courseId}/forum`);
  } catch (err) {
    console.error(err);
    res.send("Error posting to forum");
  }
});



//Materials

// GET course page with materials
app.get('/course/:id', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const user = req.session.user;
  const courseId = req.params.id;

  try {
    const courseRes = await pool.query("SELECT * FROM courses WHERE id=$1", [courseId]);
    if (courseRes.rows.length === 0) return res.send("Course not found");

    const course = courseRes.rows[0];

    // Fetch materials
    const materialsRes = await pool.query(
      'SELECT * FROM course_materials WHERE course_id=$1 ORDER BY uploaded_at DESC',
      [courseId]
    );
    const materials = materialsRes.rows;

    res.render('course_page', { user, course, materials, role: user.role });
  } catch (err) {
    console.error(err);
    res.send("Error loading course");
  }
});




// Teacher uploads course material

app.post('/course/:id/materials/upload', upload.single('material_file'), async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Teacher') return res.redirect('/login');

  const courseId = req.params.id;
  const { material_title } = req.body; // We'll use this for file_name
  const file = req.file;

  if (!material_title || !file) {
    return res.send('Title and file are required');
  }

  try {
    await pool.query(
      'INSERT INTO course_materials (course_id, file_name, file_path) VALUES ($1, $2, $3)',
      [courseId, material_title, file.filename]
    );

    res.redirect(`/course/${courseId}`);
  } catch (err) {
    console.error(err);
    res.send('Error uploading material');
  }
});



// View course materials
app.get('/course/:id/materials', async (req, res) => {
  const courseId = req.params.id;
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  try {
    const materialsResult = await pool.query(
      `SELECT * FROM course_materials WHERE course_id=$1 ORDER BY id DESC`,
      [courseId]
    );

    res.render('course_materials', {
      user,
      courseId,
      materials: materialsResult.rows
    });
  } catch (err) {
    console.error(err);
    res.send('Error fetching course materials');
  }
});



// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.post('/enroll', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Student') return res.redirect('/login');

  const student_id = req.session.user.id;
  const { course_id } = req.body;

  try {
    await pool.query(
      "INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [student_id, course_id]
    );
    res.redirect('/home'); // back to student homepage
  } catch (err) {
    console.error(err);
    res.send("Error enrolling in course");
  }
});


//GAMIFICATION

// ============================
// PRACTICE & LEADERBOARDS
// ============================
// ============================
// PRACTICE & LEADERBOARDS
// ============================


//Create course


// server.js

app.get('/course/:id/quiz/create', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Teacher') return res.redirect('/login');

  const courseId = req.params.id;

  try {
    const courseRes = await pool.query('SELECT * FROM courses WHERE id=$1', [courseId]);
    const course = courseRes.rows[0];
    if (!course) return res.status(404).send('Course not found');

    res.render('create_quiz', { course, user: req.session.user, message: '' });
  } catch (err) {
    console.error(err);
    res.send('Error loading create quiz page');
  }
});

app.post('/course/:id/quiz/create', async (req,res) => {
  if (!req.session.user || req.session.user.role !== 'Teacher') return res.redirect('/login');

  const courseId = req.params.id;
  const { title, total_points, questions } = req.body;

  if (!title || !total_points || !questions || !questions.length) {
    return res.send('All fields required, at least 1 question.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const quizRes = await client.query(
      'INSERT INTO quizzes (course_id,title,total_points) VALUES ($1,$2,$3) RETURNING id',
      [courseId, title, total_points]
    );
    const quizId = quizRes.rows[0].id;

    for (let q of questions) {
      const { question_text, options, correct_option } = q;
      if (!question_text || !options || options.length !==4 || !correct_option) continue;

      await client.query(
        `INSERT INTO quiz_questions 
          (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option) 
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [quizId, question_text, options[0], options[1], options[2], options[3], correct_option]
      );
    }

    await client.query('COMMIT');
    res.send('Quiz Created Successfully!');
  } catch(err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.send('Error creating quiz');
  } finally {
    client.release();
  }
});




// GET /practice – Student chooses course to practice
app.get('/practice', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  try {
    const coursesRes = await pool.query('SELECT id, title FROM courses ORDER BY title');
    res.render('practice_home', { courses: coursesRes.rows, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.send('Error fetching courses');
  }
});

// Leaderboard page
app.get('/practice/leaderboard', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  try {
    const leaderboardRes = await pool.query(`
      SELECT 
        u.full_name,
        sts.exp_total,
        COUNT(qs.id) AS quizzes_solved,
        ROUND(
          CASE 
            WHEN SUM(q.total_points) > 0 THEN (SUM(qs.score)::decimal / SUM(q.total_points)) * 100
            ELSE 0
          END, 2
        ) AS accuracy_rate
      FROM student_total_score sts
      JOIN users u ON u.id = sts.student_id
      LEFT JOIN quiz_submissions qs ON qs.student_id = u.id AND qs.score IS NOT NULL
      LEFT JOIN quizzes q ON q.id = qs.quiz_id
      GROUP BY u.id, sts.exp_total
      ORDER BY sts.exp_total DESC
      LIMIT 20
    `);

    res.render('leaderboard', {
      user: req.session.user,
      leaderboard: leaderboardRes.rows
    });
  } catch (err) {
    console.error(err);
    res.send("Error loading leaderboard page");
  }
});




// API: global leaderboard based on exp_total
app.get('/api/leaderboard/global', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.full_name,
        sts.exp_total,
        COUNT(qs.id) AS quizzes_solved,
        ROUND(
          CASE 
            WHEN SUM(q.total_points) > 0 THEN (SUM(qs.score)::decimal / SUM(q.total_points)) * 100
            ELSE 0
          END, 2
        ) AS accuracy_rate
      FROM student_total_score sts
      JOIN users u ON u.id = sts.student_id
      LEFT JOIN quiz_submissions qs ON qs.student_id = u.id
      LEFT JOIN quizzes q ON q.id = qs.quiz_id
      WHERE qs.score IS NOT NULL
      GROUP BY u.id, sts.exp_total
      ORDER BY sts.exp_total DESC
      LIMIT 20
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch global leaderboard' });
  }
});




//
// Function to update total_score in student_total_score
async function updateTotalScore(studentId) {
  try {
    // Sum all non-null scores
    const sumResult = await pool.query(
      'SELECT COALESCE(SUM(score),0) AS total_score FROM quiz_submissions WHERE student_id=$1',
      [studentId]
    );
    const totalScore = sumResult.rows[0].total_score;

    // Insert or update the total_score
    await pool.query(
      `INSERT INTO student_total_score (student_id, total_score)
       VALUES ($1, $2)
       ON CONFLICT (student_id)
       DO UPDATE SET total_score = EXCLUDED.total_score`,
      [studentId, totalScore]
    );
  } catch (err) {
    console.error('Error updating total_score:', err);
  }
}



// Start quiz: store started_at
// Record started_at timestamp
app.post('/practice/quiz/:quizId/start', async (req, res) => {
  const quizId = req.params.quizId;
  const studentId = req.session.user.id;

  try {
    // Check if an entry exists
    const existing = await pool.query(
      'SELECT * FROM quiz_submissions WHERE quiz_id = $1 AND student_id = $2',
      [quizId, studentId]
    );

    if (existing.rowCount > 0) {
      // Update started_at for an existing record
      await pool.query(
        `UPDATE quiz_submissions 
         SET started_at = NOW(), submitted_at = NULL, score = NULL, time_taken = NULL
         WHERE quiz_id = $1 AND student_id = $2`,
        [quizId, studentId]
      );
    } else {
      // Insert new row
      await pool.query(
        `INSERT INTO quiz_submissions (quiz_id, student_id, started_at)
         VALUES ($1, $2, NOW())`,
        [quizId, studentId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});



// GET /practice/quiz/:quizId – Attempt a quiz
app.get('/practice/quiz/:quizId', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { quizId } = req.params;

  try {
    // Fetch quiz
    const quizResult = await pool.query('SELECT * FROM quizzes WHERE id=$1', [quizId]);
    if (quizResult.rows.length === 0) {
      return res.send('Quiz not found');
    }
    const quiz = quizResult.rows[0];

    // Fetch questions
    const questionsResult = await pool.query(
      'SELECT * FROM quiz_questions WHERE quiz_id=$1 ORDER BY id',
      [quizId]
    );
    const questions = questionsResult.rows;

    if (!questions || questions.length === 0) {
      return res.send('No questions found for this quiz');
    }

    res.render('quiz_attempt', { user: req.session.user, quiz, questions });
  } catch (err) {
    console.error('Error loading quiz:', err);
    res.send('Error loading quiz');
  }
});


//SUBMT quiz
app.post('/practice/quiz/:quizId/submit', async (req, res) => {
  const { quizId } = req.params;
  const studentId = req.session.user.id;
  const answers = req.body;

  try {
    // 1️⃣ Fetch the quiz first
    const quizRes = await pool.query('SELECT * FROM quizzes WHERE id=$1', [quizId]);
    if (quizRes.rows.length === 0) return res.send('Quiz not found');
    const quiz = quizRes.rows[0];

    // 2️⃣ Fetch questions
    const questionsRes = await pool.query('SELECT * FROM quiz_questions WHERE quiz_id=$1', [quizId]);
    const questions = questionsRes.rows;

    // 3️⃣ Calculate per-question points
    const totalPoints = quiz.total_points;
    const perQuestionPoints = totalPoints / questions.length;

    // 4️⃣ Calculate score
    let score = 0;
    const questionsResult = questions.map(q => {
      const isCorrect = answers[q.id] === q.correct_option;
      if (isCorrect) score += perQuestionPoints;
      return {
        id: q.id,
        question_text: q.question_text,
        selected: answers[q.id] || null,
        correct_option: q.correct_option,
        isCorrect
      };
    });

    // 5️⃣ Calculate time taken
    const submissionRes = await pool.query(
      'SELECT started_at FROM quiz_submissions WHERE quiz_id=$1 AND student_id=$2',
      [quizId, studentId]
    );
    const startedAt = submissionRes.rows[0]?.started_at;
    const submittedAt = new Date();
    const timeTaken = startedAt ? Math.floor((submittedAt - startedAt) / 1000) : 0;

    // 6️⃣ Calculate EXP
    const expGained = Math.round(score * 2 + Math.max(0, 60 - timeTaken / 10)); // example formula

    // 7️⃣ Update quiz_submissions
    await pool.query(
      `INSERT INTO quiz_submissions (quiz_id, student_id, score, submitted_at, time_taken)
       VALUES ($1,$2,$3,NOW(),$4)
       ON CONFLICT (quiz_id, student_id)
       DO UPDATE SET 
         score = EXCLUDED.score,
         submitted_at = NOW(),
         time_taken = EXCLUDED.time_taken`,
      [quizId, studentId, score, timeTaken]
    );

    // 8️⃣ Update student_total_score (add score & exp)
    await pool.query(
      `INSERT INTO student_total_score (student_id, total_score, exp_total)
       VALUES ($1, $2, $3)
       ON CONFLICT (student_id)
       DO UPDATE SET 
         total_score = (
           SELECT COALESCE(SUM(score),0) 
           FROM quiz_submissions 
           WHERE student_id=$1
         ),
         exp_total = student_total_score.exp_total + $3`,
      [studentId, score, expGained]
    );

    // 9️⃣ Render result
    res.render('quiz_result', {
      user: req.session.user,
      quizId,
      score,
      total: totalPoints,
      questions: questionsResult,
      timeTaken,
      expGained
    });

  } catch (err) {
    console.error(err);
    res.send('Error submitting quiz');
  }
});








// List quizzes for a course (must be after /quiz/:quizId)
app.get('/practice/:courseId', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { courseId } = req.params;

  try {
    const quizzesRes = await pool.query(
      'SELECT id, title, total_points FROM quizzes WHERE course_id=$1 ORDER BY id',
      [courseId]
    );
    res.render('practice_course', { quizzes: quizzesRes.rows, courseId, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.send('Error fetching quizzes');
  }
});


//AskAI feature

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Ask AI route
// GET Ask AI page
app.get("/ask-ai", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("ask_ai", { user: req.session.user });
});

// POST Ask AI question
app.post("/ask-ai", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "Question required" });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an AI tutor helping students with programming and computer science topics." },
        { role: "user", content: question }
      ]
    });
    res.json({ answer: response.choices[0].message.content });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "AI request failed" });
  }
});




app.listen(5000, () => {
  console.log('Server running on port 5000');
});

