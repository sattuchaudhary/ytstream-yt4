const checkAuth = (req, res, next) => {
  const tokens = req.cookies.youtube_credentials;
  
  if (!tokens) {
    return res.status(401).json({
      success: false,
      error_type: 'auth_error',
      message: 'Authentication required'
    });
  }

  req.tokens = tokens;
  next();
};

module.exports = checkAuth; 