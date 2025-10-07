require('dotenv').config(); 
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');


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

app.get('/course/:id', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const user = req.session.user;
  const courseId = req.params.id;
  const role = user.role;


  try {
    // Fetch the course details
    const courseResult = await pool.query("SELECT * FROM courses WHERE id = $1", [courseId]);
    if (courseResult.rows.length === 0) {
      return res.send("Course not found");
    }

    const course = courseResult.rows[0];

    res.render('course_page', { user, course,role });
  } catch (err) {
    console.error(err);
    res.send("Error loading course");
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
