const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error_type: 'validation_error',
      message: 'File size too large. Maximum size is 50MB'
    });
  }

  if (err.name === 'MulterError') {
    return res.status(400).json({
      success: false,
      error_type: 'validation_error',
      message: err.message
    });
  }

  res.status(500).json({
    success: false,
    error_type: 'server_error',
    message: 'Internal server error'
  });
};

module.exports = errorHandler; 