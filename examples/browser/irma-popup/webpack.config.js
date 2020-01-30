const path = require('path');

module.exports = {
  mode: 'development',

  entry: {
    'irma': './index.js'
  },

  output: {
    path: path.join(__dirname, 'docs'),
    filename: '[name].js'
  },

  devServer: {
    contentBase: path.join(__dirname, 'docs'),
    disableHostCheck: true
  },

  module: {
    rules: [
      {
        test: /\.css$/i,
        use: [
          'style-loader',
          'css-loader',
        ]
      },
      {
        test: /\.ttf$/,
        loader: 'file-loader'
      }
    ]
  }
};
