require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const OpenAI = require("openai");

const app = express();

// -------------------------
// Uploads folder
// -------------------------
const uploadPath = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });

// -------------------------
// Middleware
// -------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(uploadPath));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true }
}));

// -------------------------
// PostgreSQL Pool
// -------------------------
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT
});

// -------------------------
// Multer setup
// -------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// -------------------------
// Views
// -------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// -------------------------
// OpenAI
// -------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------
// ROUTES
// -------------------------

// Home page
app.get('/', (req, res) => {
  res.render('index', { user: req.session.user });
});

// -------------------------
// Auth: Register & Login
// -------------------------
app.get('/register', (req, res) => res.render('register', { message: '' }));
app.post('/register', async (req, res) => {
  const { username, full_name, email, phone, age, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    await pool.query(
      "INSERT INTO users (username, full_name, email, phone, age, password, role) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [username, full_name, email, phone, age, hashedPassword, role]
    );
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { message: 'User already exists or invalid input' });
  }
});

app.get('/login', (req, res) => res.render('login', { message: '' }));
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
        return res.redirect('/home');
      }
    }
    res.render('login', { message: 'Invalid email or password' });
  } catch (err) {
    console.error(err);
    res.render('login', { message: 'Something went wrong' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// -------------------------
// Home dashboard (role-based)
// -------------------------
app.get('/home', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const user = req.session.user;

  if (user.role === 'Teacher') {
    try {
      const coursesResult = await pool.query("SELECT * FROM courses WHERE teacher_id=$1 ORDER BY created_at DESC", [user.id]);
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
        coursesWithStudents.push({ ...course, students: enrolledResult.rows });
      }

      res.render('home_teacher', { user, coursesWithStudents, message: '' });
    } catch (err) {
      console.error(err);
      res.send("Error loading teacher dashboard");
    }
  } else {
    // Student dashboard
    try {
      const coursesResult = await pool.query("SELECT * FROM courses ORDER BY created_at DESC");
      const courses = coursesResult.rows;

      const enrolledResult = await pool.query(
        `SELECT c.id, c.title, c.description, c.duration 
         FROM courses c
         JOIN enrollments e ON c.id = e.course_id
         WHERE e.student_id=$1
         ORDER BY c.created_at DESC`,
        [user.id]
      );

      const enrolledCourses = enrolledResult.rows;
      const enrolledCourseIds = enrolledCourses.map(c => c.id);

      for (let course of enrolledCourses) {
        const assignmentsResult = await pool.query('SELECT id, points FROM assignments WHERE course_id=$1', [course.id]);
        const assignments = assignmentsResult.rows;

        const submissionResult = await pool.query(
          `SELECT a.id AS assignment_id, s.grade 
           FROM assignments a
           LEFT JOIN submissions s
           ON a.id = s.assignment_id AND s.student_id=$1
           WHERE a.course_id=$2`,
          [user.id, course.id]
        );

        let totalGrade = 0, totalMaxPoints = 0;
        for (let a of assignments) {
          totalMaxPoints += a.points;
          const submission = submissionResult.rows.find(sub => sub.assignment_id === a.id);
          if (submission && submission.grade != null) totalGrade += submission.grade;
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

// -------------------------
// Course creation (teacher)
// -------------------------
app.post('/create-course', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Teacher') return res.redirect('/login');
  const { title, description, duration } = req.body;
  const teacher_id = req.session.user.id;

  try {
    await pool.query(
      "INSERT INTO courses (title, description, duration, teacher_id) VALUES ($1,$2,$3,$4)",
      [title, description, duration, teacher_id]
    );
    res.redirect('/home');
  } catch (err) {
    console.error(err);
    res.render('home_teacher', { user: req.session.user, message: 'Error creating course' });
  }
});

// -------------------------
// Enroll (student)
// -------------------------
app.post('/enroll', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Student') return res.redirect('/login');
  const { course_id } = req.body;

  try {
    await pool.query(
      "INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [req.session.user.id, course_id]
    );
    res.redirect('/home');
  } catch (err) {
    console.error(err);
    res.send("Error enrolling in course");
  }
});

// -------------------------
// Assignments
// -------------------------
app.get('/course/:id/assignments', async (req, res) => {
  const { id } = req.params;
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  try {
    const courseResult = await pool.query('SELECT * FROM courses WHERE id=$1', [id]);
    const course = courseResult.rows[0];

    const assignmentsResult = await pool.query('SELECT * FROM assignments WHERE course_id=$1 ORDER BY created_at DESC', [id]);
    const assignments = assignmentsResult.rows;

    for (let a of assignments) {
      const submissionsResult = await pool.query('SELECT * FROM submissions WHERE assignment_id=$1', [a.id]);
      a.submissions = submissionsResult.rows;
    }

    res.render('assignment_page', { course, assignments, role: user.role, userId: user.id, user });
  } catch (err) {
    console.error(err);
    res.send('Error loading assignments');
  }
});

app.post('/course/:id/assignments/create', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { title, description, due_date, points } = req.body;
  const marks = parseInt(points);
  if (isNaN(marks) || marks < 0 || marks > 100) return res.send('Points must be 0-100');

  const file_path = req.file ? req.file.filename : null;
  await pool.query(
    'INSERT INTO assignments (course_id, title, description, due_date, file_path, points) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, title, description, due_date, file_path, marks]
  );
  res.redirect(`/course/${id}/assignments`);
});

// -------------------------
// Course materials
// -------------------------
app.post('/course/:id/materials/upload', upload.single('material_file'), async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'Teacher') return res.redirect('/login');
  const courseId = req.params.id;
  const { material_title } = req.body;
  const file = req.file;
  if (!material_title || !file) return res.send('Title and file required');

  try {
    await pool.query(
      'INSERT INTO course_materials (course_id, file_name, file_path) VALUES ($1,$2,$3)',
      [courseId, material_title, file.filename]
    );
    res.redirect(`/course/${courseId}`);
  } catch (err) {
    console.error(err);
    res.send('Error uploading material');
  }
});

// -------------------------
// Forum
// -------------------------
app.get('/course/:id/forum', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const courseId = req.params.id;
  const user = req.session.user;

  try {
    const forumRes = await pool.query(`
      SELECT f.*, u.full_name,
        (SELECT content FROM course_forum WHERE id = f.parent_id) AS reply_to_content
      FROM course_forum f
      JOIN users u ON u.id = f.user_id
      WHERE f.course_id=$1
      ORDER BY f.created_at ASC
    `, [courseId]);

    const posts = forumRes.rows;
    const map = {}, tree = [];
    posts.forEach(p => { p.replies=[]; map[p.id]=p; });
    posts.forEach(p => p.parent_id ? map[p.parent_id]?.replies.push(p) : tree.push(p));

    res.render('course_forum', { user, courseId, posts: tree });
  } catch (err) {
    console.error(err);
    res.send("Error loading forum");
  }
});

app.post('/course/:id/forum', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const courseId = req.params.id;
  const userId = req.session.user.id;
  const { content, parent_id } = req.body;
  if (!content.trim()) return res.send('Cannot post empty content');

  try {
    await pool.query(
      'INSERT INTO course_forum (course_id, user_id, content, parent_id) VALUES ($1,$2,$3,$4)',
      [courseId, userId, content, parent_id || null]
    );
    res.redirect(`/course/${courseId}/forum`);
  } catch (err) {
    console.error(err);
    res.send("Error posting to forum");
  }
});

// -------------------------
// Ask AI
// -------------------------
app.get("/ask-ai", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("ask_ai", { user: req.session.user });
});

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

// -------------------------
// Start server
// -------------------------
app.listen(5000, () => console.log('Server running on port 5000'));
