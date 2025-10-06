require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.set('view engine', 'ejs');
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT
});

// Middleware
app.use(express.urlencoded({ extended: true })); // parses POST data
console.log('Session secret:', process.env.SESSION_SECRET);
app.use(session({
  secret: process.env.SESSION_SECRET, // must NOT be undefined
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true }
}));


app.set('view engine', 'ejs');

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
    try {
      // Get all courses created by this teacher
      const coursesResult = await pool.query(
        "SELECT * FROM courses WHERE teacher_id = $1 ORDER BY created_at DESC",
        [user.id]
      );
      const courses = coursesResult.rows;

      // For each course, get enrolled students
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
    try {
      // Fetch all courses
      const coursesResult = await pool.query("SELECT * FROM courses ORDER BY created_at DESC");
      const courses = coursesResult.rows;

      // Fetch enrolled courses for this student
      const enrolledResult = await pool.query(
        `SELECT c.id, c.title, c.description, c.duration 
         FROM courses c
         JOIN enrollments e ON c.id = e.course_id
         WHERE e.student_id = $1
         ORDER BY c.created_at DESC`,
        [user.id]
      );

      const enrolledCourses = enrolledResult.rows; // full course objects

      // For disabling enroll buttons
      const enrolledCourseIds = enrolledCourses.map(course => course.id);

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


app.listen(5000, () => {
  console.log('Server running on port 5000');
});
