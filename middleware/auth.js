const checkAuth = async (req, res, next) => {
  try {
    const tokens = req.session.tokens;
  
    if (!tokens) {
      return res.status(401).json({
        error: 'Authentication required',
        error_type: 'auth_error'
      });
    }
  
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({
      error: 'Authentication failed',
      error_type: 'auth_error'
    });
  }
};

module.exports = checkAuth; 